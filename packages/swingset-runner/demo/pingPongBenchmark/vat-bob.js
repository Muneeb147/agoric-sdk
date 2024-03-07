import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';

const log = console.log;

export function buildRootObject() {
  let myNickname;

  function makeContact(otherContact, otherNickname) {
    return makeExo(
      'contact',
      M.interface('contact', {}, { defaultGuards: 'passable' }),
      {
        ping(tag) {
          log(`${myNickname}: pinged with "${tag}", ponging ${otherNickname}`);
          E(otherContact).pong(tag, myNickname);
        },
      },
    );
  }

  return makeExo(
    'root',
    M.interface('root', {}, { defaultGuards: 'passable' }),
    {
      setNickname(nickname) {
        myNickname = nickname;
      },
      hello(otherContact, otherNickname) {
        const myContact = makeContact(otherContact, otherNickname);
        E(otherContact).myNameIs(myNickname);
        log(`${myNickname}.hello sees ${otherNickname}`);
        return myContact;
      },
    },
  );
}
