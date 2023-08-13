import { Far } from '@endo/far';
import { AssetKind } from '../../../src/index.js';

/** @type {Brand<AssetKind>} */
export const mockBrand = Far('brand', {
  // eslint-disable-next-line no-unused-vars
  isMyIssuer: async allegedIssuer => false,
  getAllegedName: () => 'mock',
  getAmountShape: () => {},
  getDisplayInfo: () => ({
    assetKind: AssetKind.NAT,
  }),
});
