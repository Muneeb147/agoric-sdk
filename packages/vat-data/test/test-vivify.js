// @ts-check

// Modeled on test-heap-classes.js
import { test } from '@agoric/swingset-vat/tools/prepare-test-env-ava.js';
import { M } from '@agoric/store';
import {
  vivifyFarClass,
  vivifyFarClassKit,
  vivifyFarInstance,
} from '../src/far-class-utils.js';
import { makeScalarBigMapStore } from '../src/vat-data-bindings.js';

const UpCounterI = M.interface('UpCounter', {
  incr: M.call()
    // TODO M.number() should not be needed to get a better error message
    .optional(M.and(M.number(), M.gte(0)))
    .returns(M.number()),
});

const DownCounterI = M.interface('DownCounter', {
  decr: M.call()
    // TODO M.number() should not be needed to get a better error message
    .optional(M.and(M.number(), M.gte(0)))
    .returns(M.number()),
});

test('test vivifyFarClass', t => {
  /* Creating a big map store with durable baggage. */
  const baggage = makeScalarBigMapStore('baggage', { durable: true });

  /* Creating a function that will create an instance of the UpCounter class. */
  const makeUpCounter = vivifyFarClass(
    baggage,
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
  t.throws(() => upCounter.incr(-3), {
    message: 'In "incr" method of (UpCounter) arg 0: -3 - Must be >= 0',
  });
  // @ts-expect-error TS doesn't know that `this` is a `Context`
  t.throws(() => upCounter.incr('foo'), {
    message:
      'In "incr" method of (UpCounter) arg 0: string "foo" - Must be a number',
  });
});

/* Test of the `vivifyFarClassKit` function. */
test('test vivifyFarClassKit', t => {
  /* Creating a big map store with durable baggage. */
  const baggage = makeScalarBigMapStore('baggage', { durable: true });

  /* Creating a kit of two classes, one that increments and one that decrements. */
  const makeCounterKit = vivifyFarClassKit(
    baggage,
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
  t.throws(() => upCounter.incr(-3), {
    message: 'In "incr" method of (Counter up) arg 0: -3 - Must be >= 0',
  });
  /* Testing that the function throws an error when the argument is not a number. */
  // @ts-expect-error the type violation is what we're testing
  t.throws(() => downCounter.decr('foo'), {
    message:
      'In "decr" method of (Counter down) arg 0: string "foo" - Must be a number',
  });
  /* Testing that the function throws an error when the argument is not a function. */
  t.throws(() => upCounter.decr(3), {
    message: 'upCounter.decr is not a function',
  });
});

/* Test of the `vivifyFarInstance` function. */
test('test vivifyFarInstance', t => {
  /* Creating a big map store with durable baggage. */
  const baggage = makeScalarBigMapStore('baggage', { durable: true });

  let x = 3;
  const upCounter = vivifyFarInstance(baggage, 'upCounter', UpCounterI, {
    incr(y = 1) {
      x += y;
      return x;
    },
  });
  t.is(upCounter.incr(5), 8);
  t.is(upCounter.incr(1), 9);
  /* Testing that the function throws an error when the argument is less than 0. */
  t.throws(() => upCounter.incr(-3), {
    message: 'In "incr" method of (upCounter) arg 0: -3 - Must be >= 0',
  });
  /* Testing that the function throws an error when the argument is not a number. */
  t.throws(() => upCounter.incr('foo'), {
    message:
      'In "incr" method of (upCounter) arg 0: string "foo" - Must be a number',
  });
});
