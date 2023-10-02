import { AssetKind, reallyPrepareIssuerKit } from '@agoric/ertp';
import { provideDurableMapStore } from '@agoric/vat-data';

/**
 *
 * @param {import('@agoric/vat-data').Baggage} baggage
 * @returns {ERef<Mint<'set'>>}
 */
export const provideQuoteMint = baggage => {
  const issuerBaggage = provideDurableMapStore(
    baggage,
    'quoteMintIssuerBaggage',
  );
  const issuerKit = reallyPrepareIssuerKit(
    issuerBaggage,
    'quote',
    AssetKind.SET,
    undefined,
    undefined,
    { recoverySetsOption: 'noRecoverySets' },
  );
  return issuerKit.mint;
};
