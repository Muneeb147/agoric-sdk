//@ts-nocheck
import * as _124 from './abci/types.js';
import * as _125 from './crypto/keys.js';
import * as _126 from './crypto/proof.js';
import * as _127 from './libs/bits/types.js';
import * as _128 from './p2p/types.js';
import * as _129 from './types/block.js';
import * as _130 from './types/evidence.js';
import * as _131 from './types/params.js';
import * as _132 from './types/types.js';
import * as _133 from './types/validator.js';
import * as _134 from './version/types.js';
export namespace tendermint {
  export const abci = {
    ..._124,
  };
  export const crypto = {
    ..._125,
    ..._126,
  };
  export namespace libs {
    export const bits = {
      ..._127,
    };
  }
  export const p2p = {
    ..._128,
  };
  export const types = {
    ..._129,
    ..._130,
    ..._131,
    ..._132,
    ..._133,
  };
  export const version = {
    ..._134,
  };
}
