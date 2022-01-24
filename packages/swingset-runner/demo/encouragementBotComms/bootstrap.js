import { E } from '@endo/eventual-send';
import { Far } from '@agoric/marshal';

const log = console.log;

log(`=> loading bootstrap.js`);

export function buildRootObject(vatPowers) {
  const { D } = vatPowers;
  return Far('root', {
    async bootstrap(vats, devices) {
      log('=> bootstrap() called');

      const BOT = 'bot';
      const USER = 'user';
      const BOT_CLIST_INDEX = 0;

      D(devices.loopbox).registerInboundHandler(USER, vats.uservattp);
      const usersender = D(devices.loopbox).getSender(USER);
      await E(vats.uservattp).registerMailboxDevice(usersender);
      const {
        transmitter: txToBotForUser,
        setReceiver: setRxFromBotForUser,
      } = await E(vats.uservattp).addRemote(BOT);
      await E(vats.usercomms).addRemote(
        BOT,
        txToBotForUser,
        setRxFromBotForUser,
      );

      D(devices.loopbox).registerInboundHandler(BOT, vats.botvattp);
      const botsender = D(devices.loopbox).getSender(BOT);
      await E(vats.botvattp).registerMailboxDevice(botsender);
      const {
        transmitter: txToUserForBot,
        setReceiver: setRxFromUserForBot,
      } = await E(vats.botvattp).addRemote(USER);
      await E(vats.botcomms).addRemote(
        USER,
        txToUserForBot,
        setRxFromUserForBot,
      );

      await E(vats.botcomms).addEgress(
        USER,
        BOT_CLIST_INDEX, // this would normally be autogenerated
        vats.bot,
      );

      const pPBot = E(vats.usercomms).addIngress(BOT, BOT_CLIST_INDEX);
      E(vats.user)
        .talkToBot(pPBot, 'bot')
        .then(
          r =>
            log(
              `=> the promise given by the call to user.talkToBot resolved to '${r}'`,
            ),
          err =>
            log(
              `=> the promise given by the call to user.talkToBot was rejected '${err}''`,
            ),
        );
    },
  });
}
