import { AmountMath } from '@agoric/ertp/src/index.js';
import { makeTracer } from '@agoric/internal';
import { makeNotifierFromAsyncIterable } from '@agoric/notifier';
import { E } from '@endo/far';

const trace = makeTracer('UpgradeVaults');

// stand-in for Promise.any() which isn't available at this point.
const any = promises =>
  new Promise((resolve, reject) => {
    for (const promise of promises) {
      promise.then(resolve);
    }
    void Promise.allSettled(promises).then(results => {
      const rejects = results.filter(({ status }) => status === 'rejected');
      if (rejects.length === results.length) {
        // @ts-expect-error TypeScript doesn't know enough
        const messages = rejects.map(({ message }) => message);
        const aggregate = new Error(messages.join(';'));
        // @ts-expect-error TypeScript doesn't know enough
        aggregate.errors = rejects.map(({ reason }) => reason);
        reject(aggregate);
      }
    });
  });

/**
 * @param {import('../../src/proposals/econ-behaviors').EconomyBootstrapPowers} powers
 * @param {{ options: { vaultsRef: { bundleID: string } } }} options
 */
export const upgradeVaults = async (powers, { options }) => {
  const {
    consume: {
      agoricNamesAdmin,
      newAuctioneerKit: auctioneerKitP,
      priceAuthority,
      vaultFactoryKit,
      zoe,
      economicCommitteeCreatorFacet: electorateCreatorFacet,
      reserveKit,
    },
    produce: { auctioneerKit: auctioneerKitProducer },
    instance: {
      produce: { auctioneer: auctioneerProducer },
    },
  } = powers;
  const { vaultsRef } = options;
  const kit = await vaultFactoryKit;
  const auctioneerKit = await auctioneerKitP;
  const { instance: directorInstance } = kit;
  const allBrands = await E(zoe).getBrands(directorInstance);
  const { Minted: istBrand, ...vaultBrands } = allBrands;

  const bundleID = vaultsRef.bundleID;
  console.log(`upgradeVaults: bundleId`, bundleID);
  let installationP;
  await null;
  if (vaultsRef) {
    if (bundleID) {
      installationP = E(zoe).installBundleID(bundleID);
      await E.when(
        installationP,
        installation =>
          E(E(agoricNamesAdmin).lookupAdmin('installation')).update(
            'vaultFactory',
            installation,
          ),
        err =>
          console.error(`🚨 failed to update vaultFactory installation`, err),
      );
    }
  }

  const readManagerParams = async () => {
    const { publicFacet: directorPF } = kit;

    await null;

    const params = {};
    for (const kwd of Object.keys(vaultBrands)) {
      const b = vaultBrands[kwd];
      const subscription = E(directorPF).getSubscription({
        collateralBrand: b,
      });
      const notifier = makeNotifierFromAsyncIterable(subscription);
      const { value } = await notifier.getUpdateSince();
      trace('readManagerParams', kwd, value.current);
      params[kwd] = harden({
        brand: b,
        debtLimit: value.current.DebtLimit.value,
        interestRate: value.current.InterestRate.value,
        liquidationMargin: value.current.LiquidationMargin.value,
        liquidationPadding: value.current.LiquidationPadding.value,
        liquidationPenalty: value.current.LiquidationPenalty.value,
        mintFee: value.current.MintFee.value,
      });
    }
    return params;
  };
  const managerParamValues = await readManagerParams();

  // upgrade the vaultFactory
  const upgradeVaultFactory = async () => {
    // @ts-expect-error cast XXX privateArgs missing from type
    const { privateArgs } = kit;

    const shortfallInvitation = await E(
      E.get(reserveKit).creatorFacet,
    ).makeShortfallReportingInvitation();

    const poserInvitation = await E(
      electorateCreatorFacet,
    ).getPoserInvitation();
    /** @type {import('../../src/vaultFactory/vaultFactory').VaultFactoryContract['privateArgs']} */
    const newPrivateArgs = harden({
      ...privateArgs,
      auctioneerInstance: auctioneerKit.instance,
      initialPoserInvitation: poserInvitation,
      initialShortfallInvitation: shortfallInvitation,
      managerParams: managerParamValues,
    });

    const upgradeResult = await E(kit.adminFacet).upgradeContract(
      bundleID,
      newPrivateArgs,
    );

    console.log('upgraded vaultFactory.', upgradeResult);
  };

  // Wait for at least one new price feed to be ready before upgrading Vaults
  void E.when(
    any(
      Object.values(vaultBrands).map(brand =>
        E(priceAuthority).quoteGiven(AmountMath.make(brand, 10n), istBrand),
      ),
    ),
    async () => {
      await upgradeVaultFactory();
      auctioneerKitProducer.reset();
      auctioneerKitProducer.resolve(auctioneerKit);
      auctioneerProducer.reset();
      auctioneerProducer.resolve(auctioneerKit.instance);
    },
  );

  console.log(`upgradeVaults scheduled; waiting for priceFeeds`);
};

const t = 'upgradeVaults';
/**
 * Return the manifest, installations, and options for upgrading Vaults.
 *
 * @param {object} _ign
 * @param {any} vaultUpgradeOptions
 */
export const getManifestForUpgradeVaults = async (
  _ign,
  vaultUpgradeOptions,
) => ({
  manifest: {
    [upgradeVaults.name]: {
      consume: {
        agoricNamesAdmin: t,
        newAuctioneerKit: t,
        economicCommitteeCreatorFacet: t,
        priceAuthority: t,
        reserveKit: t,
        vaultFactoryKit: t,
        board: t,
        zoe: t,
      },
      produce: { auctioneerKit: t },
      instance: { produce: { auctioneer: t } },
    },
  },
  options: { ...vaultUpgradeOptions },
});
