import { Far } from '@endo/far';
import { makeDurableZone } from '@agoric/zone/durable.js';
import { prepareWhenableModule } from '@agoric/whenable';
import { prepareIBCProtocol } from './ibc.js';

export function buildRootObject(_vatPowers, _args, baggage) {
  const zone = makeDurableZone(baggage);
  const powers = prepareWhenableModule(zone.subZone('whenable'));
  const makeIBCProtocolHandler = prepareIBCProtocol(
    zone.subZone('IBC'),
    powers,
  );

  function createHandlers(callbacks) {
    const ibcHandler = makeIBCProtocolHandler(callbacks);
    return harden(ibcHandler);
  }
  return Far('root', {
    createHandlers,
  });
}
