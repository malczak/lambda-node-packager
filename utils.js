const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const ZIP_CMD = './ec2_zip';
const MODULES = ['aws-sdk'];
const S3_LOCATION_REGEX = '^s3://([a-z]{1}[a-z0-9.-]{5,62})(?:/(.*))?$';

/**
 * Parse s3 uri, expected format s3://bucket/key
 * @returns {Object}
 */
function parseS3URI(string) {
    const regex = new RegExp(S3_LOCATION_REGEX);
    let match = regex.exec(string);
    if (!match) {
        return null;
    }
    return {
        Bucket: match[1],
        Key: match[2] || ''
    };
}

/**
 * Substitutes ${key} in string with object properties
 * @returns {string}
 */
function substitute(template, vars) {
    let m, search, replace, str = template;
    const regex = /\${([a-zA-Z0-9_-]+)}/gm;
    while ((m = regex.exec(str)) !== null) {
        if (m.index === regex.lastIndex) {
            regex.lastIndex++;
        }
        search = m[0];
        replace = vars[m[1]];
        str = str.replace(search, replace);
        regex.lastIndex -= (search.length + replace.length);
    }
    return str;
}

/**
 * Promisify callback based function
 * @returns {Promise}
 */
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

/**
 * Copy source file to target location
 * @returns {Promise}
 */
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

/**
 * On Lambda get a list of available node_modules
 * @returns {Array}
 */
function availableModules() {
    const runtimeDir = process.env.LAMBDA_RUNTIME_DIR;
    if (!runtimeDir) {
        return MODULES;
    }
    const lsraw = childProcess.execSync(`ls -A ${runtimeDir}/node_modules`);
    return (lsraw && lsraw.length) ? lsraw.toString('utf8').split('\n').filter(item => (item.length > 0) && (item.indexOf('.') !== 0)) : MODULES;
}

/**
 * Removes all known modules from package.dependencies
 * @return {Object}
 */
function removePreinstalledModules(packageJson) {
    const result = Object.assign({}, packageJson);
    const modules = availableModules();
    for (let module of modules) {
        delete result.dependencies[module];
    }
    return result;
}


/**
 * Create zip archive from file/directory
 */
function zip(source, target) {
    const sourceName = path.basename(source);
    try {
        let zipExec = path.resolve(__dirname, ZIP_CMD);
        fs.statSync(zipExec);
        let result = childProcess.spawnSync(zipExec,['-qr', sourceName], {cwd: path.dirname(source)});
        if (result != 0) {
            throw new Error(result.stderr.toString('utf8'));
        }
        return Promise.resolve(target);
    } catch (err) {
        // zip not available, try `archiver`
        const archiver = require('archiver');
        return new Promise(function (resolve, reject) {
            const output = fs.createWriteStream(target);
            const archive = archiver('zip', {zlib: { level: 9 }});
            archive.pipe(output)
                .on('error', reject)
                .on('close', () => resolve(target));

            const stat = fs.statSync(source);
            if (stat.isDirectory()) {
                archive.directory(source, false);
            } else {
                archive.file(source, {name: sourceName});
            }

            archive.finalize();
        });
    }
}

/**
 * Create tar/gzip archive from file/directory
 */
function tar(source, target) {
    const sourceName = path.basename(source);
    childProcess.execSync(`tar -czf ${target} ${sourceName}`, {cwd: path.dirname(source)});
}

/**
 * Unarchives tar/gzip
 */
function untar(source, target = '.') {
    try {
        let stat = fs.statSync(target);
        if (!stat.isDirectory()) {
            throw new Error('Expected dictionary but file found');
        }
    } catch (error) {
        fs.mkdirSync(target);
    }

    childProcess.execSync(`tar -xzf ${source} -C ${target}`, {cwd: path.dirname(source)});
}

/**
 * Creates a directory
 */
function mkdir(path) {
    try {
        let stat = fs.statSync(path);
        if (!stat.isDirectory()) {
            fs.unlinkSync(path);
        }
    } catch (error) {
        fs.mkdirSync(path);
    }
}

module.exports = {
    parseS3URI,
    substitute,
    promisify,
    copyFile,
    availableModules,
    removePreinstalledModules,
    zip,
    tar,
    untar,
    mkdir
};
