// @ts-check

import { M, fit } from '@agoric/store';
import '../../../exported.js';

import { vivifyKind, vivifySingleton } from '@agoric/vat-data';
import { swapExact } from '../../../src/contractSupport/index.js';
import { isAfterDeadlineExitRule } from '../../../src/typeGuards.js';

const { details: X } = assert;

const sellSeatExpiredMsg = 'The covered call option is expired.';

/**
 * @see original version in .../zoe/src/contracts/coveredCall.js and upgradeable
 * version in contracts/coveredCall-durable.js.
 *
 * This variant has minor changes to the returned strings that make it
 * identifiable, to demonstrate that upgrade has occurred.
 *
 * @param {ZCF} zcf
 * @param {unknown} _privateArgs
 * @param {import('@agoric/vat-data').Baggage} instanceBaggage
 */
const vivify = async (zcf, _privateArgs, instanceBaggage) => {
  const firstTime = !instanceBaggage.has('DidStart');
  if (firstTime) {
    instanceBaggage.init('DidStart', true);
  }
  const upgraded = firstTime ? 'V3 ' : 'V3 upgraded ';

  // TODO the exerciseOption offer handler that this makes is an object rather
  // than a function for now only because we do not yet support durable
  // functions.
  const makeExerciser = vivifyKind(
    instanceBaggage,
    'makeExerciserKindHandle',
    sellSeat => ({ sellSeat }),
    {
      handle: ({ state: { sellSeat } }, buySeat) => {
        assert(!sellSeat.hasExited(), sellSeatExpiredMsg);
        try {
          swapExact(zcf, sellSeat, buySeat);
        } catch (err) {
          console.log(
            `Swap ${upgraded}failed. Please make sure your offer has the same underlyingAssets and strikePrice as specified in the invitation details. The keywords should not matter.`,
            err,
          );
          throw err;
        }
        zcf.shutdown(`Swap ${upgraded}completed.`);
        return `The ${upgraded}option was exercised. Please collect the assets in your payout.`;
      },
    },
  );

  /** @type {OfferHandler} */
  const makeOption = sellSeat => {
    fit(sellSeat.getProposal(), M.split({ exit: { afterDeadline: M.any() } }));
    const sellSeatExitRule = sellSeat.getProposal().exit;
    if (!isAfterDeadlineExitRule(sellSeatExitRule)) {
      assert.fail(
        X`the seller must have an afterDeadline exitRule, but instead had ${sellSeatExitRule}`,
      );
    }

    const exerciseOption = makeExerciser(sellSeat);
    const customProps = harden({
      expirationDate: sellSeatExitRule.afterDeadline.deadline,
      timeAuthority: sellSeatExitRule.afterDeadline.timer,
      underlyingAssets: sellSeat.getProposal().give,
      strikePrice: sellSeat.getProposal().want,
    });
    return zcf.makeInvitation(exerciseOption, 'exerciseOption', customProps);
  };

  const creatorFacet = vivifySingleton(instanceBaggage, 'creatorFacet', {
    makeInvitation: () => zcf.makeInvitation(makeOption, 'makeCallOption'),
  });
  return harden({ creatorFacet });
};

harden(vivify);
export { vivify };
