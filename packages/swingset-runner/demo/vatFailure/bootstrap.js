import { E } from '@agoric/eventual-send';

export function buildRootObject(_vatPowers, vatParameters) {
  const ourThing = harden({
    pretendToBeAThing(from) {
      console.log(`pretendToBeAThing invoked from ${from}`);
    },
  });
  const self = harden({
    async bootstrap(vats, devices) {
      let badvat;
      if (vatParameters.argv[0] === '--bedynamic') {
        const vatMaker = E(vats.vatAdmin).createVatAdminService(
          devices.vatAdmin,
        );
        const vat = await E(vatMaker).createVatByName('badvat', {
          enableSetup: true,
        });
        badvat = vat.root;
      } else {
        badvat = vats.badvatStatic;
      }
      const p1 = E(badvat).begood(ourThing);
      p1.then(
        () => console.log('p1 resolve (bad!)'),
        e => console.log(`p1 reject ${e}`),
      );
      const p2 = E(badvat).bebad(ourThing);
      p2.then(
        () => console.log('p2 resolve (bad!)'),
        e => console.log(`p2 reject ${e}`),
      );
      const p3 = E(badvat).begood(ourThing);
      p3.then(
        () => console.log('p3 resolve (bad!)'),
        e => console.log(`p3 reject ${e}`),
      );
    },
  });
  return self;
}
