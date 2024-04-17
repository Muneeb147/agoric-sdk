import { makeHelpers } from '@agoric/deploy-script-support';

import { getManifestForUpgradeWallet } from '@agoric/smart-wallet/src/proposals/upgrade-wallet-factory3-proposal.js';

/**
 * @file
 *   `agoric run scripts/smart-wallet/build-wallet-factory3-upgrade.js`
 * produces a proposal and permit file, as well as the necessary bundles. It
 * also prints helpful instructions for copying the files and installing them.
 */

/** @type {import('@agoric/deploy-script-support/src/externalTypes.js').ProposalBuilder} */
export const defaultProposalBuilder = async ({ publishRef, install }) =>
  harden({
    sourceSpec:
      '@agoric/smart-wallet/src/proposals/upgrade-wallet-factory3-proposal.js',
    getManifestCall: [
      getManifestForUpgradeWallet.name,
      {
        walletRef: publishRef(
          install('@agoric/smart-wallet/src/walletFactory.js'),
        ),
        zcfRef: publishRef(install('@agoric/zoe/src/contractFacet/vatRoot.js')),
      },
    ],
  });

export default async (homeP, endowments) => {
  const { writeCoreProposal } = await makeHelpers(homeP, endowments);
  await writeCoreProposal('upgrade-wallet-factory', defaultProposalBuilder);
};
