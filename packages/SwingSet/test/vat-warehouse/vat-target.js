import { Far } from '@endo/far';

export function buildRootObject(_vatPowers, _vatParameters) {
  const contents = [];
  function append(thing) {
    contents.push(thing);
    return harden([...contents]);
  }

  const target = makeExo(
    'root',
    M.interface('root', {}, { defaultGuards: 'passable' }),
    {
      append,
    },
  );

  return target;
}
