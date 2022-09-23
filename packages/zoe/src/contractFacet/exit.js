import { assert, details as X, q } from '@agoric/assert';
import { E } from '@endo/eventual-send';
import { vivifyFarClass, provideDurableSetStore } from '@agoric/vat-data';
import { M, initEmpty } from '@agoric/store';

import {
  isOnDemandExitRule,
  isAfterDeadlineExitRule,
  isWaivedExitRule,
} from '../typeGuards.js';

const ExitObjectGuard = M.interface('ExitObject', { exit: M.call().returns() });
const WakerInterfaceGuard = M.interface('Waker', {
  wake: M.call(M.bigint()).returns(),
  schedule: M.call().returns(),
});

export const makeMakeExiter = baggage => {
  const activeWakers = provideDurableSetStore(baggage, 'activeWakers');

  const makeExitable = vivifyFarClass(
    baggage,
    'ExitObject',
    ExitObjectGuard,
    zcfSeat => ({ zcfSeat }),
    {
      exit() {
        // @ts-expect-error context isn't known yet.
        const { state } = this;
        state.zcfSeat.exit();
      },
    },
  );
  const makeWaived = vivifyFarClass(
    baggage,
    'ExitWaived',
    ExitObjectGuard,
    initEmpty,
    {
      exit() {
        // in this case the user has no ability to exit their seat on demand
        throw Error(
          `Only seats with the exit rule "onDemand" can exit at will`,
        );
      },
    },
  );
  const makeWaker = vivifyFarClass(
    baggage,
    'Waker',
    WakerInterfaceGuard,
    (zcfSeat, afterDeadline) => ({ zcfSeat, afterDeadline }),
    {
      wake(_when) {
        // @ts-expect-error context isn't known yet.
        const { state, self } = this;

        activeWakers.delete(self);
        state.zcfSeat.exit();
      },
      schedule() {
        // @ts-expect-error context isn't known yet.
        const { state, self } = this;

        E(state.afterDeadline.timer)
          .setWakeup(state.afterDeadline.deadline, self)
          .catch(reason => {
            console.error(
              `The seat could not be made with the provided timer ${state.afterDeadline.timer} and deadline ${state.afterDeadline.deadline}`,
            );
            console.error(reason);
            state.zcfSeat.fail(reason);
            throw reason;
          });
      },
    },
  );

  // On revival, reschedule all the active wakers.
  for (const waker of activeWakers.values()) {
    waker.schedule();
  }

  /**
   * Makes the appropriate exitObj, which runs in ZCF and allows the seat's owner
   * to request the position be exited.
   *
   * @type {MakeExitObj}
   */
  return (proposal, zcfSeat) => {
    const { exit } = proposal;

    if (isOnDemandExitRule(exit)) {
      // Allow the user to exit their seat on demand. Note: we must wrap
      // it in an object to send it back to Zoe because our marshalling layer
      // only allows two kinds of objects: records (no methods and only
      // data) and presences (local proxies for objects that may have
      // methods).
      return makeExitable(zcfSeat);
    }

    if (isAfterDeadlineExitRule(exit)) {
      const waker = makeWaker(zcfSeat, exit.afterDeadline);
      activeWakers.add(waker);
      // Automatically exit the seat after deadline.
      waker.schedule();
    }

    if (isWaivedExitRule(exit) || isAfterDeadlineExitRule(exit)) {
      return makeWaived();
    }

    assert.fail(X`exit kind was not recognized: ${q(exit)}`);
  };
};
