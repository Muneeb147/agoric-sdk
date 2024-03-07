import { Far } from '@endo/far';

export function buildRootObject() {
  return makeExo(
    'root',
    M.interface('root', {}, { defaultGuards: 'passable' }),
    {
      hang() {
        // eslint-disable-next-line no-empty
        for (;;) {}
      },
    },
  );
}
