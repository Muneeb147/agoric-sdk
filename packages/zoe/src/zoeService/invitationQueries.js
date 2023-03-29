import { assert, details as X } from '@agoric/assert';
import { E } from '@endo/eventual-send';
import { getCopyBagEntries } from '@agoric/store';

/** @param {Issuer<'copyBag'>} invitationIssuer */
export const makeInvitationQueryFns = invitationIssuer => {
  /** @type {GetInvitationDetails} */
  const getInvitationDetails = async invitationP => {
    const onRejected = reason => {
      const err = assert.error(
        X`A Zoe invitation is required, not ${invitationP}`,
      );
      assert.note(err, X`Due to ${reason}`);
      throw err;
    };
    const amtP = E(invitationIssuer).getAmountOf(invitationP).catch(onRejected);
    return amtP.then(({ value }) => getCopyBagEntries(value)[0][0]);
  };

  /** @type {GetInstance} */
  const getInstance = invitation =>
    E.get(getInvitationDetails(invitation)).instance;

  /** @type {GetInstallation} */
  const getInstallation = invitation =>
    E.get(getInvitationDetails(invitation)).installation;

  return harden({
    getInstance,
    getInstallation,
    getInvitationDetails,
  });
};
