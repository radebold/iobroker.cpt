const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const ioPkgPath = path.join(root, 'io-package.json');
const lockPath = path.join(root, 'package-lock.json');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

const pkg = readJson(pkgPath);
const version = pkg.version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Version ${version} is not valid SemVer for npm/ioBroker.`);
}

const ioPkg = readJson(ioPkgPath);
ioPkg.common = ioPkg.common || {};
ioPkg.common.version = version;
ioPkg.version = version;
writeJson(ioPkgPath, ioPkg);

const lock = readJson(lockPath);
lock.version = version;
if (lock.packages && lock.packages['']) {
  lock.packages[''].version = version;
}
writeJson(lockPath, lock);

console.log(`Synchronized version to ${version} in package.json, io-package.json and package-lock.json`);
