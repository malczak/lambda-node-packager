const AWS = require('aws-sdk');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const utils = require('./utils');

const modulesNameTemplate = 'modules-${projectName}-${checksum}';
const archiveNameTemplate = 'archived-${projectName}';

// @todo add option to only install and pack node_modules
/*
 - archite
    +(1)- project
    |       +- fetch package
    |       +- unpack package
    |       +- build node_modules (ref 2)
    |       +- zip package
    |       +- upload project package to s3
    |
    +(2)- node_modules
    |       +- load package.json
    |       +- cleanup dependencies
    |       +- calculate hash
    |       +- already cached?
    |       |       +(Y)- building project?
    |       |       |       +(Y)- download and finish
    |       |       +(N)- build modules
    |       |       |       +- run npm install
    |       |       |       +- compress node_modules
    |       |       |       +- upload to s3
    |       +- finish
*/

/**
 * Create node_modules archive, cached in s3 based on dependencies hash
 */
async function archiveModules(opts) {
    const packageFolder = 'package-modules';
    const {source, cacheUri = null, keep = false} = opts;
    const logInfo = opts.logInfo || (function () {process.stdout.write(util.format.apply(util, arguments) + '\n');});
    const packageJson = (typeof source == 'string') ? JSON.parse(source.endsWith('.json') ? fs.readFileSync(source, 'utf8') : source) : source;
    const projectName = packageJson.name.replace(/\s+/, '-');
    const cache = utils.parseS3URI(cacheUri);
    let s3 = null;

    // Create tmp package dir
    const ownsWorkDir = opts.workDir == null;
    const workDir = ownsWorkDir ? fs.mkdtempSync(path.join(os.tmpdir(), 'modules-')) : opts.workDir;
    const pckgDir = path.join(workDir, packageFolder);
    const installDir = path.join(pckgDir, 'npm');
    utils.mkdir(pckgDir);
    utils.mkdir(installDir);
    logInfo(`working dir set to '${workDir}'; owns = ${ownsWorkDir ? 'Y' : 'N'}`);

    // remove known dependencies (eq. 'aws-sdk')
    const clearedPackage = utils.removePreinstalledModules(packageJson);

    // Get deps checksum
    const dependencies = clearedPackage.dependencies;
    const checksum = crypto.createHash('md5').update(JSON.stringify(dependencies), 'utf8').digest('hex');

    // Crete archive name
    const archiveName = `${utils.substitute(modulesNameTemplate, {projectName, checksum})}.tgz`;
    const archivePath = path.join(pckgDir, archiveName);

    // If cache is enabled, try to get it
    let foundInCache = false;
    if (cache) {
        s3 = new AWS.S3();
        cache.Key = `${cache.Key}/${archiveName}`.replace(/^\/+/, '');
        logInfo(`cache enabled; uri = ${cacheUri}`, cache);

        const operation = keep ? 'getObject' : 'headObject';
        try {
            let response = await s3[operation](cache).promise();

            logInfo('archive found in cache');

            // write to file and unarchive
            if (response.Body) {
                fs.writeFileSync(archivePath, response.Body);
            }

            foundInCache = true;
        } catch (error) {
            // not in cache
        }
    }

    if (!foundInCache) {
        const packagePath = path.join(installDir, 'package.json');

        // save package.json
        logInfo(`updating package config; file = '${packagePath}'`);
        fs.writeFileSync(packagePath, JSON.stringify(clearedPackage), {flags: 'w+'});

        // run `npm install --production --no-optional`
        logInfo('installing all dependencies');
        childProcess.execSync(`export HOME='${installDir}' && npm install --quiet --production --no-optional`, {cwd: installDir});

        // Compress archive node_modules -> targz
        logInfo('creating node_modules archive');
        const output = path.join(installDir, 'node_modules');
        utils.tar(output, archivePath);

        // if using cache, upload it
        if (cache) {
            // Save in S3 cache
            logInfo('uploading to s3 cache');
            let response = await s3.upload(Object.assign({
                Body: fs.createReadStream(archivePath)
            }, cache)).promise();

            logInfo(`Saved in cache; location = ${response.Location}`);
        }
    }

    if (keep) {
        logInfo(`modules left in '${workDir}'`);
        utils.untar(archivePath, workDir);
    }

    childProcess.execSync(`rm -rf ${packageFolder}`, {cwd: workDir});
    return archiveName;
}

/**
 * Project packager
 * possible use cases:
 *     1) build node_modules for production on Lambda, cache package on s3 - point to package.json
 *     2) build whole project - source and node modules (reuse cache as in case 1) - point to tar.gz created with npm pack
*/
function archiveProject(opts) {
    // this should be run once per container
    const {sourceUri, targetUri, cacheUri, keep = false} = opts;
    const logInfo = opts.logInfo || (function () {process.stdout.write(util.format.apply(util, arguments) + '\n');});

    const source = utils.parseS3URI(sourceUri) || sourceUri;

    const inFileName = (source.Key || source).match(/[^/]*.tgz$/g)[0];
    if (!inFileName) {
        const err = new Error('Expected package name \'[a-zA-Z0-9\\-\\.]*.tgz\'');
        return Promise.reject(err);
    }

    const outFileName = inFileName.replace(/\.[^.]*$/,'.zip');
    const targetFileUri = targetUri.endsWith('.zip') ? targetUri : `${targetUri}/${outFileName}`.replace(/^\/+/, '');
    const target = utils.parseS3URI(targetFileUri) || targetFileUri;

    // create tmp dir structure /tmp/packager-xxx/package
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packager-'));
    const pckgDir = path.join(rootDir, 'package');
    logInfo(`working dir set to '${rootDir}'`);

    return fetchProject(source)
        .then(buildModules)
        .then(createArchive)
        .then(uploadPackage)
        .then(result => {
            if (!keep) cleanup();
            return result;
        });

    function fetchProject(source) {
        const sourceIsS3 = (typeof source != 'string');
        const filePath = path.join(rootDir, inFileName);
        let getPackage = null;

        if (sourceIsS3) {
            // Fetch package created with `npm pack`
            logInfo(`downloading package archive from s3://${source.Bucket}/${source.Key}`);
            const s3 = new AWS.S3();
            getPackage = s3.getObject(source).promise().then(response => {
                fs.writeFileSync(filePath, response.Body);
            });
        } else {
            getPackage = utils.copyFile(source, filePath);
        }

        logInfo('unarachiving package archive');
        return getPackage
            .then(() => {
                const archivePath = path.join(rootDir, inFileName);
                utils.untar(archivePath);
                return rootDir;
            });
    }

    function buildModules() {
        const packagePath = path.join(pckgDir, 'package.json');
        const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        const projectName = packageJson.name.replace(/\s+/, '-');
        return archiveModules({
            source: packageJson,
            workDir: pckgDir,
            cacheUri,
            keep: true
        }).then(modules => {
            return {projectName, modules};
        });
    }

    function createArchive(opts) {
        const {projectName} = opts;
        const archiveName = `${utils.substitute(archiveNameTemplate, {projectName})}.zip`;
        const archivePath = path.join(rootDir, archiveName);
        logInfo(`archiving project code; file = ${archivePath}`);
        return utils.zip(pckgDir, archivePath);
    }

    function uploadPackage(archivePath) {
        let promise = null;

        const targetIsS3 = (typeof target != 'string');
        if (targetIsS3) {
            // upload package to S3
            const s3 = new AWS.S3();
            logInfo(`uploading '${archivePath}' to s3://${target.Bucket}/${target.Key}`);
            promise = s3.upload({
                Bucket: target.Bucket,
                Key: target.Key,
                Body: fs.createReadStream(archivePath)
            }).promise();
        } else {
            // copy file to local
            logInfo(`saving archive; file = ${target}`);
            promise = utils.copyFile(archivePath, target);
        }

        return promise.then(() => targetFileUri);
    }

    function cleanup() {
        logInfo('cleanning up...');
        childProcess.execSync(`rm -rf ${rootDir}`);
    }
}

function lambdaArchive(event, context, callback) {
    const {mode = 'project', ...opts} = event;
    const handler = {project: archiveProject, modules: archiveModules}[mode];

    (handler ? handler(opts) : Promise.reject(new Error('Unexpected mode')))
        .then(result => callback(null, result))
        .catch(err => callback(err, null));
}

exports.archiveModules = archiveModules;

exports.archiveProject = exports.archive = archiveProject;

exports.handler = lambdaArchive;
