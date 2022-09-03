// @ts-check

// Modeled on test-heap-classes.js

import { test } from '@agoric/swingset-vat/tools/prepare-test-env-ava.js';
import { M } from '@agoric/store';
import {
  defineVirtualFarClass,
  defineVirtualFarClassKit,
} from '../src/far-class-utils.js';

/* Defining an interface for the UpCounter class. */
const UpCounterI = M.interface('UpCounter', {
  incr: M.call()
    // TODO M.number() should not be needed to get a better error message
    .optional(M.and(M.number(), M.gte(0)))
    .returns(M.number()),
});

/* Defining an interface for the DownCounter class. */
const DownCounterI = M.interface('DownCounter', {
  decr: M.call()
    // TODO M.number() should not be needed to get a better error message
    .optional(M.and(M.number(), M.gte(0)))
    .returns(M.number()),
});

/* Defining a class called UpCounter. */
test('test defineVirtualFarClass', t => {
  const makeUpCounter = defineVirtualFarClass(
    'UpCounter',
    UpCounterI,
    (x = 0) => ({ x }),
    {
      incr(y = 1) {
        // @ts-expect-error TS doesn't know that `this` is a `Context`
        const { state } = this;
        state.x += y;
        return state.x;
      },
    },
  );
  const upCounter = makeUpCounter(3);
  t.is(upCounter.incr(5), 8);
  t.is(upCounter.incr(1), 9);
  /* Testing that the function throws an error when the argument is not a number. */
  t.throws(() => upCounter.incr(-3), {
    message: 'In "incr" method of (UpCounter) arg 0: -3 - Must be >= 0',
  });
  /* Testing that the function throws an error when the argument is not a number. */
  // @ts-expect-error TS doesn't know that `this` is a `Context`
  t.throws(() => upCounter.incr('foo'), {
    message:
      'In "incr" method of (UpCounter) arg 0: string "foo" - Must be a number',
  });
});

test('test defineVirtualFarClassKit', t => {
  const makeCounterKit = defineVirtualFarClassKit(
    'Counter',
    harden({ up: UpCounterI, down: DownCounterI }),
    (x = 0) => ({ x }),
    {
      up: {
        incr(y = 1) {
          const { state } = this;
          state.x += y;
          return state.x;
        },
      },
      down: {
        decr(y = 1) {
          const { state } = this;
          state.x -= y;
          return state.x;
        },
      },
    },
  );
  const { up: upCounter, down: downCounter } = makeCounterKit(3);
  t.is(upCounter.incr(5), 8);
  t.is(downCounter.decr(), 7);
  t.is(upCounter.incr(3), 10);
  /* Testing that the function throws an error when the argument is not a number. */
  t.throws(() => upCounter.incr(-3), {
    message: 'In "incr" method of (Counter up) arg 0: -3 - Must be >= 0',
  });
  /* Testing that the function throws an error when the argument is not a number. */
  // @ts-expect-error the type violation is what we're testing
  t.throws(() => downCounter.decr('foo'), {
    message:
      'In "decr" method of (Counter down) arg 0: string "foo" - Must be a number',
  });
  /* Testing that the upCounter does not have a decr method. */
  t.throws(() => upCounter.decr(3), {
    message: 'upCounter.decr is not a function',
  });
});
