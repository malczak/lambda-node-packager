const AWS = require('aws-sdk');
const fs = require('fs');
const childProcess = require('child_process');
const os = require('os');
const path = require('path');
const util = require('util');

const ZIP_CMD = './ec2_zip';
const MODULES = ['aws-sdk'];
const archiveNameTemplate = 'archived-${projectName}';

function promisify(fn, ...args) {
    return new Promise((resolve, reject) => {
        fn(...args, (...resultArgs) => {
            if (resultArgs[0]) {
                return reject(resultArgs[0]);
            }
            resultArgs = resultArgs.splice(1, Infinity);
            resolve(resultArgs.length > 1 ? resultArgs : resultArgs[0]);
        });
    });
}

function copyFile(source, target) {    
    return new Promise(function(resolve, reject){
        var rd = fs.createReadStream(source);
        rd.on('error', reject);
        var wr = fs.createWriteStream(target);
        wr.on('error', reject);
        wr.on('close', () => resolve());
        rd.pipe(wr);
    });
}

function availableModules() {
    const runtimeDir = process.env.LAMBDA_RUNTIME_DIR;
    if (!runtimeDir) { 
        return MODULES;
    }
    const lsraw = childProcess.execSync(`ls -A ${runtimeDir}/node_modules`);
    return (lsraw && lsraw.length) ? lsraw.toString('utf8').split('\n').filter(item => (item.length > 0) && (item.indexOf('.') !== 0)) : MODULES;
}

function removePreinstalledModules(packageJson) {
    const result = Object.assign({}, packageJson);
    const modules = availableModules();
    for (let module of modules) {
        delete result.dependencies[module];
    }
    return result;
}

function pack(opts) {
    // this should be run once per container
    const {bucket, inkey, disableUpload} = opts;
    const logInfo = opts.logInfo || (() => process.stdout.write(util.format.apply(util, arguments) + '\n'));

    const inFileName = inkey.match(/[^/]*.tgz$/g)[0];    
    if (!inFileName) {
        const err = new Error('Expected package name \'[a-zA-Z0-9\\-\\.]*.tgz\'');        
        return Promise.reject(err);
    }
    const outkey = opts.outkey || inkey.replace(/\.[^.]*$/,'.zip');

    // create tmp dir
    logInfo('creating working directory');
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packager-'));
    const pckgDir = path.join(rootDir, 'package');

    return fetchProject(bucket, inkey)
        .then(runPackager)
        .then(createArchive)
        .then(uploadPackage)
        .then(result => {
            cleanup();
            return result;
        })
        .catch(error => {
            cleanup();
            throw error;
        });

    function fetchProject(bucket, key) {
        // on lambda fetch file from S3
        const isLambda = !!((process.env.LAMBDA_TASK_ROOT && process.env.AWS_EXECUTION_ENV) || false);    
        if (isLambda) {
            // Fetch package created with `npm pack`
            logInfo(`downloading package archive from s3://${bucket}/${key}`);
            const s3 = new AWS.S3();
            return s3.getObject({
                Bucket: bucket, 
                Key: key
            }).promise().then(response => {
                // save & extract tgz to pckgDir
                logInfo('unarachiving package archive');
                const filePath = path.join(rootDir, inFileName);
                fs.writeFileSync(filePath, response.Body);
                childProcess.execSync(`tar -xzf ${inFileName}`, {cwd: rootDir});
            });
        }

        logInfo('unarachiving package archive');
        const filePath = path.join(rootDir, inFileName);
        return copyFile(key, filePath)
            .then(() => promisify(childProcess.exec, `tar -xzf ${inFileName}`, {cwd: rootDir}));        
    }

    function runPackager() {
        return new Promise(function(resolve, reject) {
            try {
                const pckgFilePath = path.join(pckgDir, 'package.json');

                // load packge.json
                const packageJson = JSON.parse(fs.readFileSync(pckgFilePath, 'utf8'));
        
                // remove 'aws-sdk' etc dependencies
                const clearedPackage = removePreinstalledModules(packageJson);
            
                // save package.json
                logInfo(`updating package config; file = '${pckgFilePath}'`);
                fs.writeFileSync(pckgFilePath, JSON.stringify(clearedPackage));
            
                // run `npm install --production --no-optional`
                logInfo('installing all dependencies');            
                childProcess.execSync(`export HOME='${pckgDir}' && npm install --quiet --production --no-optional`, {cwd: pckgDir});

                resolve();
            }catch (error) {
                reject(error);
            }
        });
    }

    function createArchive() {
        const archiveName = archiveNameTemplate.replace('${projectName}', inFileName.replace(/\.[^.]*$/,'.zip'));        
        const archivePath = path.join(rootDir, archiveName);
        logInfo(`archiving lambda; file = ${archiveName}`);
        try {
            fs.statSync(ZIP_CMD);
            return promisify(childProcess.exec, `${ZIP_CMD} -qr ${archivePath}`, {cwd: pckgDir}).then(() => archivePath);
        } catch (err) {
            // zip not available, try 
            const archiver = require('archiver');
            return new Promise(function (resolve, reject) {
                const output = fs.createWriteStream(archivePath);
                const archive = archiver('zip', {zlib: { level: 9 }});
                archive.pipe(output)
                    .on('error', reject)
                    .on('close', () => resolve(archivePath));
                archive.directory(pckgDir, false);
                archive.finalize();
            });        
        }    
    }
 
    function uploadPackage(archivePath) {
        if (disableUpload === false) {
            // upload package to S3
            const s3 = new AWS.S3();
            logInfo(`uploading '${archivePath}' to s3://${bucket}/${outkey}`);
            return s3.upload({
                Bucket: bucket,
                Key: outkey,
                Body: fs.createReadStream(archivePath)
            }).promise();    
        } else {
            // copy file to local 
            logInfo(`saving archive; file = ${outkey}`);
            return copyFile(archivePath, outkey);
        }
    }

    function cleanup() {
        logInfo('cleanning up...');
        childProcess.execSync(`rm -rf ${rootDir}`);
    }
}

function lambdaPack(event, context, callback) {
    pack(event)
        .then(result => callback(null, result))
        .catch(err => callback(err, null));
}

exports.pack = pack;

exports.handler = lambdaPack;
