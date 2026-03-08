# iobroker.cpt
Test Test Chargepoint Chargingg station

## Release workflow

Use these commands to keep adapter versions consistent:

```bash
npm run version:sync
npm run release:alpha
npm run release:patch
./scripts/build-zip.sh
```

`version:sync` copies the version from `package.json` into `io-package.json` and `package-lock.json`, which avoids npm/ioBroker mismatches.
