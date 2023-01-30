import {
  AmountMath,
  AmountShape,
  BrandShape,
  DisplayInfoShape,
  IssuerShape,
  PaymentShape,
  PurseShape,
} from '@agoric/ertp';
import { makeStoredPublishKit, observeNotifier } from '@agoric/notifier';
import { M, makeScalarMapStore, mustMatch } from '@agoric/store';
import {
  defineVirtualExoClassKit,
  makeScalarBigMapStore,
  pickFacet,
} from '@agoric/vat-data';
import { E } from '@endo/far';
import { makeInvitationsHelper } from './invitations.js';
import { makeOfferExecutor } from './offers.js';
import { shape } from './typeGuards.js';
import { objectMapStoragePath } from './utils.js';

const { Fail, quote: q } = assert;

const ERROR_LAST_OFFER_ID = -1;

/**
 * @template K, V
 * @param {MapStore<K, V> } map
 * @returns {Record<K, V>}
 */
const mapToRecord = map => Object.fromEntries(map.entries());

/**
 * @file Smart wallet module
 *
 * @see {@link ../README.md}}
 */

// One method yet but structured to support more. For example,
// maybe suggestIssuer for https://github.com/Agoric/agoric-sdk/issues/6132
// setting petnames and adding brands for https://github.com/Agoric/agoric-sdk/issues/6126
/**
 * @typedef {{
 *   method: 'executeOffer'
 *   offer: import('./offers.js').OfferSpec,
 * }} BridgeAction
 */

/**
 * Purses is an array to support a future requirement of multiple purses per brand.
 *
 * @typedef {{
 *   brands: BrandDescriptor[],
 *   purses: Array<{brand: Brand, balance: Amount}>,
 *   offerToUsedInvitation: { [offerId: string]: Amount },
 *   offerToPublicSubscriberPaths: { [offerId: string]: { [subscriberName: string]: string } },
 *   lastOfferId: string,
 * }} CurrentWalletRecord
 */

/**
 * @typedef {{ updated: 'offerStatus', status: import('./offers.js').OfferStatus } |
 * { updated: 'balance'; currentAmount: Amount } |
 * { updated: 'brand', descriptor: BrandDescriptor }
 * } UpdateRecord Record of an update to the state of this wallet.
 *
 * Client is responsible for coalescing updates into a current state. See `coalesceUpdates` utility.
 *
 * The reason for this burden on the client is that transferring the full state is untenable
 * (because it would grow monotonically).
 *
 * `balance` update supports forward-compatibility for more than one purse per
 * brand. An additional key will be needed to disambiguate. For now the brand in
 * the amount suffices.
 */

/**
 * @typedef {{
 *   brand: Brand,
 *   displayInfo: DisplayInfo,
 *   issuer: Issuer,
 *   petname: import('./types').Petname
 * }} BrandDescriptor
 * For use by clients to describe brands to users. Includes `displayInfo` to save a remote call.
 */

// imports
/** @typedef {import('./types').RemotePurse} RemotePurse */

/**
 * @typedef {{
 *   address: string,
 *   bank: ERef<import('@agoric/vats/src/vat-bank').Bank>,
 *   invitationPurse: Purse<'set'>,
 * }} UniqueParams
 *
 * @typedef {{
 *   agoricNames: ERef<import('@agoric/vats').NameHub>,
 *   registry: {
 *     getRegisteredAsset: (b: Brand) => BrandDescriptor,
 *     getRegisteredBrands: () => BrandDescriptor[],
 *   },
 *   invitationIssuer: Issuer<'set'>,
 *   invitationBrand: Brand<'set'>,
 *   invitationDisplayInfo: DisplayInfo,
 *   publicMarshaller: Marshaller,
 *   storageNode: ERef<StorageNode>,
 *   zoe: ERef<ZoeService>,
 * }} SharedParams
 *
 * @typedef {ImmutableState & MutableState} State
 * - `brandPurses` is precious and closely held. defined as late as possible to reduce its scope.
 * - `offerToInvitationMakers` is precious and closely held.
 * - `offerToPublicSubscriberPaths` is precious and closely held.
 * - `purseBalances` is a cache of what we've received from purses. Held so we can publish all balances on change.
 *
 * @typedef {UniqueParams & SharedParams} HeldParams
 *
 * @typedef {Readonly<HeldParams & {
 *   paymentQueues: MapStore<Brand, Array<import('@endo/far').FarRef<Payment>>>,
 *   offerToInvitationMakers: MapStore<string, import('./types').RemoteInvitationMakers>,
 *   offerToPublicSubscriberPaths: MapStore<string, Record<string, string>>,
 *   offerToUsedInvitation: MapStore<string, Amount>,
 *   brandPurses: MapStore<Brand, RemotePurse>,
 *   purseBalances: MapStore<RemotePurse, Amount>,
 *   updatePublishKit: StoredPublishKit<UpdateRecord>,
 *   currentPublishKit: StoredPublishKit<CurrentWalletRecord>,
 * }>} ImmutableState
 *
 * @typedef {{
 * }} MutableState
 */

/**
 *
 * @param {UniqueParams} unique
 * @param {SharedParams} shared
 * @returns {State}
 */
export const initState = (unique, shared) => {
  // Some validation of inputs.
  mustMatch(
    unique,
    harden({
      address: M.string(),
      bank: M.eref(M.remotable()),
      invitationPurse: PurseShape,
    }),
  );
  mustMatch(
    shared,
    harden({
      agoricNames: M.eref(M.remotable('agoricNames')),
      invitationIssuer: IssuerShape,
      invitationBrand: BrandShape,
      invitationDisplayInfo: DisplayInfoShape,
      publicMarshaller: M.remotable('Marshaller'),
      storageNode: M.eref(M.remotable('StorageNode')),
      zoe: M.eref(M.remotable('ZoeService')),
      registry: M.remotable('AssetRegistry'),
    }),
  );

  // NB: state size must not grow monotonically
  // This is the node that UIs subscribe to for everything they need.
  // e.g. agoric follow :published.wallet.agoric1nqxg4pye30n3trct0hf7dclcwfxz8au84hr3ht
  const myWalletStorageNode = E(shared.storageNode).makeChildNode(
    unique.address,
  );

  const myCurrentStateStorageNode =
    E(myWalletStorageNode).makeChildNode('current');

  const preciousState = {
    // Private purses. This assumes one purse per brand, which will be valid in MN-1 but not always.
    brandPurses: makeScalarBigMapStore('brand purses', { durable: true }),
    // Payments that couldn't be deposited when received.
    // NB: vulnerable to uncapped growth by unpermissioned deposits.
    paymentQueues: makeScalarBigMapStore('payments queues', {
      durable: true,
    }),
    // Invitation amounts to save for persistent lookup
    offerToUsedInvitation: makeScalarBigMapStore(
      'invitation amounts by offer',
      {
        durable: true,
      },
    ),
    // Invitation makers yielded by offer results
    offerToInvitationMakers: makeScalarBigMapStore(
      'invitation makers by offer',
      {
        durable: true,
      },
    ),
    // Public subscribers yielded by offer results
    offerToPublicSubscriberPaths: makeScalarBigMapStore(
      'public subscribers by offer',
      {
        durable: true,
      },
    ),
  };

  const nonpreciousState = {
    // What purses have reported on construction and by getCurrentAmountNotifier updates.
    purseBalances: makeScalarMapStore(),
    /** @type {StoredPublishKit<UpdateRecord>} */
    updatePublishKit: harden(
      makeStoredPublishKit(myWalletStorageNode, shared.publicMarshaller),
    ),
    /** @type {StoredPublishKit<CurrentWalletRecord>} */
    currentPublishKit: harden(
      makeStoredPublishKit(myCurrentStateStorageNode, shared.publicMarshaller),
    ),
  };

  return {
    ...shared,
    ...unique,
    ...nonpreciousState,
    ...preciousState,
  };
};

const behaviorGuards = {
  helper: M.interface('helperFacetI', {
    updateBalance: M.call(PurseShape, AmountShape).optional('init').returns(),
    publishCurrentState: M.call().returns(),
    addBrand: M.call(
      {
        brand: BrandShape,
        issuer: M.eref(IssuerShape),
        petname: M.string(),
        displayInfo: DisplayInfoShape,
      },
      M.eref(PurseShape),
    ).returns(M.promise()),
  }),
  deposit: M.interface('depositFacetI', {
    receive: M.callWhen(M.await(M.eref(PaymentShape))).returns(AmountShape),
  }),
  offers: M.interface('offers facet', {
    executeOffer: M.call(shape.OfferSpec).returns(M.promise()),
    getLastOfferId: M.call().returns(M.number()),
  }),
  self: M.interface('selfFacetI', {
    handleBridgeAction: M.call(shape.StringCapData, M.boolean()).returns(
      M.promise(),
    ),
    getDepositFacet: M.call().returns(M.remotable()),
    getOffersFacet: M.call().returns(M.remotable()),
    getCurrentSubscriber: M.call().returns(M.remotable()),
    getUpdatesSubscriber: M.call().returns(M.remotable()),
  }),
};

const SmartWalletKit = defineVirtualExoClassKit(
  'SmartWallet',
  behaviorGuards,
  initState,
  {
    helper: {
      /**
       * @param {RemotePurse} purse
       * @param {Amount<any>} balance
       * @param {'init'} [init]
       */
      updateBalance(purse, balance, init) {
        const { purseBalances, updatePublishKit } = this.state;
        if (init) {
          purseBalances.init(purse, balance);
        } else {
          purseBalances.set(purse, balance);
        }
        updatePublishKit.publisher.publish({
          updated: 'balance',
          currentAmount: balance,
        });
        const { helper } = this.facets;
        helper.publishCurrentState();
      },

      publishCurrentState() {
        const {
          currentPublishKit,
          offerToUsedInvitation,
          offerToPublicSubscriberPaths,
          purseBalances,
          registry,
        } = this.state;
        currentPublishKit.publisher.publish({
          brands: registry.getRegisteredBrands(),
          purses: [...purseBalances.values()].map(a => ({
            brand: a.brand,
            balance: a,
          })),
          offerToUsedInvitation: mapToRecord(offerToUsedInvitation),
          offerToPublicSubscriberPaths: mapToRecord(
            offerToPublicSubscriberPaths,
          ),
          // @ts-expect-error FIXME leftover from offer id string conversion
          lastOfferId: ERROR_LAST_OFFER_ID,
        });
      },

      /** @type {(desc: BrandDescriptor, purse: ERef<RemotePurse>) => Promise<void>} */
      async addBrand(desc, purseRef) {
        const { address, brandPurses, paymentQueues, updatePublishKit } =
          this.state;
        const pursesHas = brandPurses.has(desc.brand);
        assert(!pursesHas, 'repeated brand from bank asset subscription');

        const purse = await purseRef; // promises don't fit in durable storage

        brandPurses.init(desc.brand, purse);

        const { helper } = this.facets;
        // publish purse's balance and changes
        void E.when(
          E(purse).getCurrentAmount(),
          balance => helper.updateBalance(purse, balance, 'init'),
          err =>
            console.error(address, 'initial purse balance publish failed', err),
        );
        void observeNotifier(E(purse).getCurrentAmountNotifier(), {
          updateState(balance) {
            helper.updateBalance(purse, balance);
          },
          fail(reason) {
            console.error(address, `failed updateState observer`, reason);
          },
        });

        updatePublishKit.publisher.publish({
          updated: 'brand',
          descriptor: desc,
        });

        // deposit queued payments
        const payments = paymentQueues.has(desc.brand)
          ? paymentQueues.get(desc.brand)
          : [];
        // @ts-expect-error xxx with DataOnly / FarRef types
        const deposits = payments.map(p => E(purse).deposit(p));
        Promise.all(deposits).catch(err =>
          console.error('ERROR depositing queued payments', err),
        );
      },
    },
    /**
     * Similar to {DepositFacet} but async because it has to look up the purse.
     */
    deposit: {
      /**
       * Put the assets from the payment into the appropriate purse.
       *
       * If the purse doesn't exist, we hold the payment until it does.
       *
       * @param {import('@endo/far').FarRef<Payment>} payment
       * @returns {Promise<Amount>} amounts for deferred deposits will be empty
       */
      async receive(payment) {
        const { brandPurses, paymentQueues: queues } = this.state;
        const brand = await E(payment).getAllegedBrand();

        // When there is a purse deposit into it
        if (brandPurses.has(brand)) {
          const purse = brandPurses.get(brand);
          // @ts-expect-error deposit does take a FarRef<Payment>
          return E(purse).deposit(payment);
        }

        // When there is no purse, queue the payment
        if (queues.has(brand)) {
          queues.get(brand).push(payment);
        } else {
          queues.init(brand, harden([payment]));
        }
        return AmountMath.makeEmpty(brand);
      },
    },
    offers: {
      /**
       * @deprecated
       * @returns {number} an error code, for backwards compatibility with clients expecting a number
       */
      getLastOfferId() {
        return ERROR_LAST_OFFER_ID;
      },
      /**
       * Take an offer description provided in capData, augment it with payments and call zoe.offer()
       *
       * @param {import('./offers.js').OfferSpec} offerSpec
       * @returns {Promise<void>} when the offer has been sent to Zoe; payouts go into this wallet's purses
       * @throws if any parts of the offer can be determined synchronously to be invalid
       */
      async executeOffer(offerSpec) {
        const { facets } = this;
        const {
          address,
          zoe,
          brandPurses,
          invitationBrand,
          invitationPurse,
          invitationIssuer,
          offerToInvitationMakers,
          offerToUsedInvitation,
          offerToPublicSubscriberPaths,
          registry,
          updatePublishKit,
        } = this.state;

        const logger = {
          info: (...args) => console.info('wallet', address, ...args),
          error: (...args) => console.log('wallet', address, ...args),
        };

        const executor = makeOfferExecutor({
          zoe,
          depositFacet: facets.deposit,
          invitationIssuer,
          powers: {
            invitationFromSpec: makeInvitationsHelper(
              zoe,
              invitationBrand,
              invitationPurse,
              offerToInvitationMakers.get,
            ),
            /**
             * @param {Brand} brand
             * @returns {Promise<RemotePurse>}
             */
            purseForBrand: async brand => {
              if (brandPurses.has(brand)) {
                return brandPurses.get(brand);
              }
              const desc = registry.getRegisteredAsset(brand);
              const { bank } = this.state;
              /** @type {RemotePurse} */
              // @ts-expect-error cast to RemotePurse
              const purse = E(bank).getPurse(desc.brand);
              await facets.helper.addBrand(desc, purse);
              return purse;
            },
            logger,
          },
          onStatusChange: offerStatus => {
            logger.info('offerStatus', offerStatus);
            updatePublishKit.publisher.publish({
              updated: 'offerStatus',
              status: offerStatus,
            });
          },
          /** @type {(offerId: string, invitationAmount: Amount<'set'>, invitationMakers: import('./types').RemoteInvitationMakers, publicSubscribers?: import('./types').PublicSubscribers | import('@agoric/notifier').TopicMetasRecord) => Promise<void>} */
          onNewContinuingOffer: async (
            offerId,
            invitationAmount,
            invitationMakers,
            publicSubscribers,
          ) => {
            offerToUsedInvitation.init(offerId, invitationAmount);
            offerToInvitationMakers.init(offerId, invitationMakers);
            const pathMap = await objectMapStoragePath(publicSubscribers);
            if (pathMap) {
              logger.info('recording pathMap', pathMap);
              offerToPublicSubscriberPaths.init(offerId, pathMap);
            }
            facets.helper.publishCurrentState();
          },
        });
        await executor.executeOffer(offerSpec);
      },
    },
    self: {
      /**
       *
       * @param {import('@endo/marshal').CapData<string>} actionCapData of type BridgeAction
       * @param {boolean} [canSpend=false]
       * @returns {Promise<void>}
       */
      handleBridgeAction(actionCapData, canSpend = false) {
        const { publicMarshaller } = this.state;
        const { offers } = this.facets;

        return E.when(
          E(publicMarshaller).unserialize(actionCapData),
          /** @param {BridgeAction} action */
          action => {
            switch (action.method) {
              case 'executeOffer': {
                assert(canSpend, 'executeOffer requires spend authority');
                return offers.executeOffer(action.offer);
              }
              default: {
                throw Fail`invalid handle bridge action ${q(action)}`;
              }
            }
          },
        );
      },
      getDepositFacet() {
        return this.facets.deposit;
      },
      getOffersFacet() {
        return this.facets.offers;
      },
      getCurrentSubscriber() {
        return this.state.currentPublishKit.subscriber;
      },
      getUpdatesSubscriber() {
        return this.state.updatePublishKit.subscriber;
      },
    },
  },
  {
    finish: ({ state, facets }) => {
      const {
        invitationBrand,
        invitationDisplayInfo,
        invitationIssuer,
        invitationPurse,
      } = state;
      const { helper } = facets;
      // Ensure a purse for each issuer
      void helper.addBrand(
        {
          brand: invitationBrand,
          issuer: invitationIssuer,
          petname: 'invitations',
          displayInfo: invitationDisplayInfo,
        },
        // @ts-expect-error cast to RemotePurse
        /** @type {RemotePurse} */ (invitationPurse),
      );

      // Schedule creation of a purse for each registered brand.
      state.registry.getRegisteredBrands().forEach(desc => {
        // In this sync method, we can't await the outcome.
        void E(state.bank)
          .getPurse(desc.brand)
          // @ts-expect-error cast
          .then((/** @type {RemotePurse} */ purse) =>
            helper.addBrand(desc, purse),
          );
      });
    },
  },
);

/**
 * Holders of this object:
 * - vat (transitively from holding the wallet factory)
 * - wallet-ui (which has key material; dapps use wallet-ui to propose actions)
 */
export const makeSmartWallet = pickFacet(SmartWalletKit, 'self');
harden(makeSmartWallet);

/** @typedef {ReturnType<typeof makeSmartWallet>} SmartWallet */
