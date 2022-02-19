import { Far } from '@endo/marshal';
import { makePriceAuthorityRegistry } from '@agoric/zoe/tools/priceAuthorityRegistry.js';
import { makeScriptedPriceAuthority } from '@agoric/zoe/tools/scriptedPriceAuthority.js';

import '@agoric/swingset-vat/src/kernel/vatManager/types.js';

/** @type {BuildRootObjectForTestVat} */
export function buildRootObject(_vatPowers) {
  return Far('root', {
    makePriceAuthority: makePriceAuthorityRegistry,
    makeFakePriceAuthority: async options =>
      makeScriptedPriceAuthority(options),
  });
}
