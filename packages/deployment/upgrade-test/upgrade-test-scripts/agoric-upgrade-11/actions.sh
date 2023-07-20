#!/bin/bash

. ./upgrade-test-scripts/env_setup.sh

# CWD is agoric-sdk
here=./upgrade-test-scripts/agoric-upgrade-11

# Pre-steps:
#  * fill Wallets
#  * install bundles
#  * create instance of prober contract and run expecting no atomicRearrange
#
# Action:
#  * upgrade Zoe and ZCF
#
# Finish
#  * create instance of prober contract and run expecting to see atomicRearrange

# This test needs bundles for Zoe, ZCF, and the prober to be installed in this
# directory, with names matching *bundle.json. The bundleIds for Zoe and ZCF
# must be updated in zcf-upgrade-script.js, while the prober's bundleId goes in
# run-prober.script. The bundles can be generated by running the test in
# vats/test/bootstrapTests/test-zcf-upgrade.js. The Zoe and ZCF bundle files are
# generated in ~/.agoric/cache, and their bundleIds are logged in the test. The
# prober bundle is generated by uncommenting `fs.writeFile(...)` in that test.
#  !!   THERE HAS TO BE A BETTER WAY   !!

yarn bundle-source --cache-json /tmp packages/vats/src/vat-zoe.js Zoe-upgrade
yarn bundle-source --cache-json /tmp packages/zoe/src/contractFacet/vatRoot.js Zcf-upgrade
yarn --silent run bundle-source --cache-json /tmp packages/vats/test/bootstrapTests/zcfProbe.js zcfProbeecho checking bundle hashes generated vs expected...
ZOE_HASH=`jq -r .endoZipBase64Sha512 /tmp/bundle-Zoe-upgrade.json`
ZCF_HASH=`jq -r .endoZipBase64Sha512 /tmp/bundle-Zcf-upgrade.json`
PROBER_HASH=`jq -r .endoZipBase64Sha512 /tmp/bundle-zcfProbe.json`

echo checking hashes against ${here}/zoe-full-upgrade/zcf-upgrade-script.js
echo ZOE: $ZOE_HASH
grep $ZOE_HASH ${here}/zoe-full-upgrade/zcf-upgrade-script.js || exit 1
echo ZCF: $ZCF_HASH
grep $ZCF_HASH ${here}/zoe-full-upgrade/zcf-upgrade-script.js || exit 1
echo checking hashes against ${here}/zoe-full-upgrade/run-prober-script.js
echo PROBE: $PROBER_HASH
grep $PROBER_HASH ${here}/zoe-full-upgrade/run-prober-script.js || exit 1
echo bundle hashes ok

echo XXXX fill wallet XXXXXX
agd tx bank send validator $GOV1ADDR  12340000000${ATOM_DENOM} --from validator --chain-id agoriclocal --keyring-backend test --yes
agops vaults open --wantMinted 10000 --giveCollateral 2000 > wantIST
agops perf satisfaction  --executeOffer wantIST  --from gov1 --keyring-backend test

echo XXXX install bundles XXXXXX
bundles=/tmp/bundle-Zoe-upgrade.json /tmp/bundle-Zcf-upgrade.json
for f in $bundles; do
  echo installing   $f
  agd tx swingset install-bundle "@$f" \
    --from gov1 --keyring-backend=test --gas=auto \
    --chain-id=agoriclocal -bblock --yes
done


echo XXXX Run prober first time XXXXXX
$here/zoe-full-upgrade/run-prober.sh
test_val "$(agd query vstorage data published.prober-asid9a -o jsonlines | jq -r '.value' | jq -r '.values[0]')" "false" "Prober couldn't call zcf.atomicReallocate()"


# upgrade zoe to a version that can change which ZCF is installed; tell Zoe to
# use a new version of ZCF.  THIS MATCHES THE UPGRADE OF THE LIVE CHAIN
echo XXXX upgrade Zoe and ZCF XXXXXX
$here/zoe-full-upgrade/zcf-upgrade-driver.sh


echo XXXX Run prober second time XXXXXX
# Re-run prober test and expect internal atomicRearrange.
$here/zoe-full-upgrade/run-prober.sh
test_val "$(agd query vstorage data published.prober-asid9a -o jsonlines | jq -r '.value' | jq -r '.values[0]')" "true" "Prober called zcf.atomicReallocate()"
