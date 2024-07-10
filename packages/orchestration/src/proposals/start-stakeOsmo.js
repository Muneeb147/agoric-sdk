import { makeTracer } from '@agoric/internal';
import { makeStorageNodeChild } from '@agoric/internal/src/lib-chainStorage.js';
import { E } from '@endo/far';

/**
 * @import {IBCConnectionID} from '@agoric/vats';
 * @import {StakeIcaSF} from '../examples/stakeIca.contract';
 */

const trace = makeTracer('StartStakeOsmo', true);

/**
 * @param {BootstrapPowers & {
 *   installation: {
 *     consume: {
 *       stakeIca: Installation<
 *         import('../examples/stakeIca.contract.js').start
 *       >;
 *     };
 *   };
 * }} powers
 */
export const startStakeOsmo = async ({
  consume: {
    agoricNames,
    board,
    chainStorage,
    chainTimerService,
    cosmosInterchainService,
    startUpgradable,
  },
  installation: {
    consume: { stakeIca },
  },
  instance: {
    // @ts-expect-error stakeOsmo not typed
    produce: { stakeOsmo: produceInstance },
  },
}) => {
  const VSTORAGE_PATH = 'stakeOsmo';
  trace('startStakeOsmo');
  await null;

  const storageNode = await makeStorageNodeChild(chainStorage, VSTORAGE_PATH);
  const marshaller = await E(board).getPublishingMarshaller();

  /** @type {StartUpgradableOpts<StakeIcaSF>} */
  const startOpts = {
    label: 'stakeOsmo',
    installation: stakeIca,
    terms: {
      remoteChainName: 'osmosis',
    },
    privateArgs: {
      agoricNames: await agoricNames,
      cosmosInterchainService: await cosmosInterchainService,
      storageNode,
      marshaller,
      timer: await chainTimerService,
    },
  };

  const { instance } = await E(startUpgradable)(startOpts);
  produceInstance.resolve(instance);
};
harden(startStakeOsmo);

export const getManifestForStakeOsmo = (
  { restoreRef },
  { installKeys, ...options },
) => {
  return {
    manifest: {
      [startStakeOsmo.name]: {
        consume: {
          agoricNames: true,
          board: true,
          chainStorage: true,
          chainTimerService: true,
          cosmosInterchainService: true,
          startUpgradable: true,
        },
        installation: {
          consume: { stakeIca: true },
        },
        instance: {
          produce: { stakeOsmo: true },
        },
      },
    },
    installations: {
      stakeIca: restoreRef(installKeys.stakeIca),
    },
    options,
  };
};
