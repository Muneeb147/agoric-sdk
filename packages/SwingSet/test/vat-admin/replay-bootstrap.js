import { E } from '@agoric/eventual-send';
import { makePromiseKit } from '@agoric/promise-kit';
import { Far } from '@endo/marshal';

export function buildRootObject() {
  const { promise: vatAdminSvc, resolve: gotVatAdminSvc } = makePromiseKit();
  let root;
  let vats;

  return Far('root', {
    async bootstrap(vats0, devices) {
      vats = vats0;
      gotVatAdminSvc(E(vats.vatAdmin).createVatAdminService(devices.vatAdmin));
    },

    async createVat() {
      const bcap = await E(vatAdminSvc).getNamedBundlecap('dynamic');
      const vc = await E(vatAdminSvc).createVat(bcap);
      root = vc.root;
      const count = await E(root).first();
      return count === 1 ? 'created' : `wrong counter ${count}`;
    },

    // if the dynamic vat was not reloaded into the next-generation swingset,
    // root~.second() will fail (there won't be a vat in ephemeral.vats when
    // the message comes to the top of the run queue, and our result promise
    // will never resolve)

    // if the vat exists but its transcript was not replayed, the +=1 will
    // not have happened, and root~.second() will return 20, not 21

    async check() {
      const count = await E(root).second();
      return count === 21 ? 'ok' : `wrong counter ${count}`;
    },
  });
}
