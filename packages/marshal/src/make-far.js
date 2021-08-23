// @ts-check

// eslint-disable-next-line spaced-comment
/// <reference types="ses"/>

import { assert, details as X, q } from '@agoric/assert';
import { assertChecker, PASS_STYLE } from './helpers/passStyleHelpers.js';
import {
  assertIface,
  getInterfaceOf,
  RemotableHelper,
} from './helpers/remotable.js';
import { passStyleOf } from './passStyleOf.js';

const { ownKeys } = Reflect;
const { prototype: functionPrototype } = Function;
const {
  defineProperty,
  getPrototypeOf,
  setPrototypeOf,
  create,
  isFrozen,
  prototype: objectPrototype,
} = Object;

/**
 * Do a deep copy of the object, handling Proxies and recursion.
 * The resulting copy is guaranteed to be pure data, as well as hardened.
 * Such a hardened, pure copy cannot be used as a communications path.
 *
 * @template {OnlyData} T
 * @param {T} val input value.  NOTE: Must be hardened!
 * @returns {T} pure, hardened copy
 */
export const pureCopy = val => {
  // passStyleOf now asserts that val has no pass-by-copy cycles.
  const passStyle = passStyleOf(val);
  switch (passStyle) {
    case 'bigint':
    case 'boolean':
    case 'null':
    case 'number':
    case 'string':
    case 'undefined':
    case 'symbol':
      return val;

    case 'copyArray':
    case 'copyRecord': {
      const obj = /** @type {Object} */ (val);

      // Create a new identity.
      const copy = /** @type {T} */ (passStyle === 'copyArray' ? [] : {});

      // Make a deep copy on the new identity.
      // Object.entries(obj) takes a snapshot (even if a Proxy).
      // Since we already know it is a copyRecord or copyArray, we
      // know that Object.entries is safe enough. On a copyRecord it
      // will represent all the own properties. On a copyArray it
      // will represent all the own properties except for the length.
      Object.entries(obj).forEach(([prop, value]) => {
        copy[prop] = pureCopy(value);
      });
      return harden(copy);
    }

    case 'error': {
      assert.fail(X`Errors cannot be copied: ${val}`, TypeError);
    }

    case 'remotable': {
      assert.fail(
        X`Input value ${q(
          passStyle,
        )} cannot be copied as it must be passed by reference`,
        TypeError,
      );
    }

    case 'promise': {
      assert.fail(X`Promises cannot be copied`, TypeError);
    }

    default:
      assert.fail(
        X`Input value ${q(passStyle)} is not recognized as data`,
        TypeError,
      );
  }
};
harden(pureCopy);

/**
 * Now that the remotableProto does not provide its own `toString` method,
 * ensure it always inherits from something. The original prototype of
 * `remotable` if there was one, or `Object.prototype` otherwise.
 *
 * @param {Object} remotable
 * @param {InterfaceSpec} iface
 * @returns {Object}
 */
const makeRemotableProto = (remotable, iface) => {
  let oldProto = getPrototypeOf(remotable);
  if (typeof remotable === 'object') {
    if (oldProto === null) {
      oldProto = objectPrototype;
    }
    assert(
      oldProto === objectPrototype || oldProto === null,
      X`For now, remotables cannot inherit from anything unusual, in ${remotable}`,
    );
  } else if (typeof remotable === 'function') {
    assert(
      oldProto !== null,
      X`Original function must not inherit from null: ${remotable}`,
    );
    assert(
      oldProto === functionPrototype ||
        getPrototypeOf(oldProto) === functionPrototype,
      X`Far functions must originally inherit from Function.prototype, in ${remotable}`,
    );
  } else {
    assert.fail(X`unrecognized typeof ${remotable}`);
  }
  return harden(
    create(oldProto, {
      [PASS_STYLE]: { value: 'remotable' },
      [Symbol.toStringTag]: { value: iface },
    }),
  );
};

const assertCanBeRemotable = candidate =>
  RemotableHelper.canBeValid(candidate, assertChecker);

/**
 * Create and register a Remotable.  After this, getInterfaceOf(remotable)
 * returns iface.
 *
 * // https://github.com/Agoric/agoric-sdk/issues/804
 *
 * @param {InterfaceSpec} [iface='Remotable'] The interface specification for
 * the remotable. For now, a string iface must be "Remotable" or begin with
 * "Alleged: ", to serve as the alleged name. More general ifaces are not yet
 * implemented. This is temporary. We include the
 * "Alleged" as a reminder that we do not yet have SwingSet or Comms Vat
 * support for ensuring this is according to the vat hosting the object.
 * Currently, Alice can tell Bob about Carol, where VatA (on Alice's behalf)
 * misrepresents Carol's `iface`. VatB and therefore Bob will then see
 * Carol's `iface` as misrepresented by VatA.
 * @param {undefined} [props=undefined] Currently may only be undefined.
 * That plan is that own-properties are copied to the remotable
 * @param {object} [remotable={}] The object used as the remotable
 * @returns {object} remotable, modified for debuggability
 */
export const Remotable = (
  iface = 'Remotable',
  props = undefined,
  remotable = {},
) => {
  assertIface(iface);
  iface = pureCopy(harden(iface));
  assert(iface);
  // TODO: When iface is richer than just string, we need to get the allegedName
  // in a different way.
  assert(props === undefined, X`Remotable props not yet implemented ${props}`);

  // Fail fast: check that the unmodified object is able to become a Remotable.
  assertCanBeRemotable(remotable);

  // Ensure that the remotable isn't already marked.
  assert(
    !(PASS_STYLE in remotable),
    X`Remotable ${remotable} is already marked as a ${q(
      remotable[PASS_STYLE],
    )}`,
  );
  // Ensure that the remotable isn't already frozen.
  assert(!isFrozen(remotable), X`Remotable ${remotable} is already frozen`);
  const remotableProto = makeRemotableProto(remotable, iface);

  // Take a static copy of the enumerable own properties as data properties.
  // const propDescs = getOwnPropertyDescriptors({ ...props });
  const mutateHardenAndCheck = target => {
    // defineProperties(target, propDescs);
    setPrototypeOf(target, remotableProto);
    harden(target);
    assertCanBeRemotable(target);
  };

  // Fail fast: check a fresh remotable to see if our rules fit.
  mutateHardenAndCheck({});

  // Actually finish the new remotable.
  mutateHardenAndCheck(remotable);

  // COMMITTED!
  // We're committed, so keep the interface for future reference.
  assert(iface !== undefined); // To make TypeScript happy
  return remotable;
};
harden(Remotable);

/**
 * Wrap function with defensive layer for hardening and checking the
 * args and outcome (result or error).
 *
 * @param {(...args: any[]) => any} func
 * @param {FarOptions=} options
 * @returns {(...args: any[]) => any}
 */
const wrapFuncDefensively = (func, { allowNonPassables = false } = {}) => {
  const name = func.name;
  const wrapper = (...args) => {
    let result;
    for (const arg of args) {
      harden(arg);
      if (!allowNonPassables) {
        try {
          passStyleOf(arg);
        } catch (er) {
          // eslint-disable-next-line no-debugger
          debugger;
          assert.fail(
            X`${q(name)} arg ${arg} should be passable: ${er} ${q(`${func}`)}`,
          );
        }
      }
    }
    // eslint-disable-next-line no-useless-catch
    try {
      // Purposely drop `this`. If we decide to preserve `this` somewhat,
      // we could `apply(meth, wrapper, args)` though this would
      // fail at inheritance. If we need to support inheritance as well,
      // we could change from an arrow function to a concise method.
      result = func(...args);
    } catch (err) {
      harden(err);
      // Don't bother checking. Consider it legal to throw unpassable
      // errors. TODO: We should check that it *is* an error.
      throw err;
    }
    harden(result);
    if (!allowNonPassables) {
      try {
        passStyleOf(result);
      } catch (er) {
        // eslint-disable-next-line no-debugger
        debugger;
        assert.fail(
          X`${q(name)} result ${result} should be passable: ${er} ${q(
            `${func}`,
          )}`,
        );
      }
    }
    return result;
  };
  defineProperty(wrapper, 'name', { value: name });
  return wrapper;
};

/**
 * A concise convenience for the most common `Remotable` use.
 *
 * @template T
 * @param {string} farName This name will be prepended with `Alleged: `
 * for now to form the `Remotable` `iface` argument.
 * @param {T|undefined} [remotable={}] The object used as the remotable
 * @param {FarOptions=} options
 * @returns {T} remotable, modified for debuggability and wrapped to
 * enforce only passables pass.
 */
export const Far = (farName, remotable = undefined, options = {}) => {
  let wrapper;
  if (remotable === undefined) {
    wrapper = undefined;
  } else if (typeof remotable === 'object') {
    wrapper = {};
    // @ts-ignore If we get here, typeof remotable === 'object'.
    // I thought typescript would figure this out. I even rewrote it this
    // way so that it would.
    for (const name of ownKeys(remotable)) {
      const meth = remotable[name];
      if (typeof meth === 'function' && getInterfaceOf(meth) === undefined) {
        wrapper[name] = wrapFuncDefensively(meth, options);
      } else {
        // For now, just to preserve the error for tests
        wrapper[name] = meth;
      }
      // Now that we've grabbed this property, ruin the original enough
      // to likely detect if it is used again.
      delete remotable[name];
    }
    // Now that we've grabbed its methods, ruin the original enough
    // to likely detect if it is used again.
    setPrototypeOf(remotable, null);
  } else if (typeof remotable === 'function') {
    // @ts-ignore If we get here, remotable is a function
    wrapper = wrapFuncDefensively(remotable, options);
    // We rely only on `remotable`'s call behavior. Ruin the rest of it
    // as much as we can to help detect if it is directly used again.

    for (const name of ownKeys(remotable)) {
      try {
        delete remotable[name];
      } catch {
        // We know we cannot delete all own properties of a function.
        // That's ok. We ruin it as much as we can.
      }
    }
    setPrototypeOf(remotable, null);
  } else {
    assert.fail(
      X`unexpected remotable typeof ${q(typeof remotable)}: ${remotable}`,
    );
  }
  return Remotable(`Alleged: ${farName}`, undefined, wrapper);
};
harden(Far);

/**
 * Coerce `func` to a far function that preserves its call behavior.
 * If it is already a far function, return it. Otherwise make and return a
 * new far function that wraps `func` and forwards calls to it. This
 * works even if `func` is already frozen. `ToFarFunction` is to be used
 * when the function comes from elsewhere under less control. For functions
 * you author in place, better to use `Far` on their function literal directly.
 *
 * @param {string} farName to be used only if `func` is not already a
 * far function.
 * @param {(...args: any[]) => any} func
 */
export const ToFarFunction = (farName, func) => {
  if (getInterfaceOf(func) !== undefined) {
    return func;
  }
  return Far(farName, (...args) => func(...args));
};
harden(ToFarFunction);
