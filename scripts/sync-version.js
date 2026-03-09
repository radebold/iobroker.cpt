const fs = require('fs');

const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
const ioPkg = JSON.parse(fs.readFileSync('./io-package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('./package-lock.json', 'utf8'));

ioPkg.common = ioPkg.common || {};
ioPkg.common.version = pkg.version;
lock.version = pkg.version;
if (lock.packages && lock.packages['']) {
  lock.packages[''].version = pkg.version;
}

fs.writeFileSync('./io-package.json', JSON.stringify(ioPkg, null, 2) + '\n');
fs.writeFileSync('./package-lock.json', JSON.stringify(lock, null, 2) + '\n');

console.log(`Version synchronized: ${pkg.version}`);
