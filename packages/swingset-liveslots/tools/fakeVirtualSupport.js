/* global globalThis */
/* eslint-disable max-classes-per-file */
import { assert, Fail } from '@endo/errors';
import { makeMarshal } from '@endo/marshal';
import { isPromise } from '@endo/promise-kit';

import { parseVatSlot } from '../src/parseVatSlots.js';
import { makeVirtualReferenceManager } from '../src/virtualReferences.js';
import { makeWatchedPromiseManager } from '../src/watchedPromises.js';
import { makeFakeVirtualObjectManager } from './fakeVirtualObjectManager.js';
import { makeFakeCollectionManager } from './fakeCollectionManager.js';

/**
 * @import { KVStore } from '@agoric/swing-store'
 */

const {
  WeakRef: RealWeakRef,
  WeakMap: RealWeakMap,
  WeakSet: RealWeakSet,
} = globalThis;

class FakeFinalizationRegistry {
  // eslint-disable-next-line no-useless-constructor, no-empty-function
  constructor() {}

  // eslint-disable-next-line class-methods-use-this
  register(_target, _heldValue, _unregisterToken) {}

  // eslint-disable-next-line class-methods-use-this
  unregister(_unregisterToken) {}
}

class FakeWeakRef {
  #target;

  constructor(target) {
    this.#target = target;
  }

  deref() {
    return this.#target; // strong ref
  }
}

/**
 * @param {Map<string, string>} map
 */
export function makeKVStoreFromMap(map) {
  let sortedKeys;
  let priorKeyReturned;
  let priorKeyIndex;

  function ensureSorted() {
    if (!sortedKeys) {
      sortedKeys = [];
      for (const key of map.keys()) {
        sortedKeys.push(key);
      }
      sortedKeys.sort((k1, k2) => k1.localeCompare(k2));
    }
  }

  function clearGetNextKeyCache() {
    priorKeyReturned = undefined;
    priorKeyIndex = -1;
  }
  clearGetNextKeyCache();

  function clearSorted() {
    sortedKeys = undefined;
    clearGetNextKeyCache();
  }

  /** @type {KVStore} */
  const fakeStore = harden({
    has(key) {
      return map.has(key);
    },
    get(key) {
      return map.get(key);
    },
    getNextKey(priorKey) {
      assert.typeof(priorKey, 'string');
      ensureSorted();
      // TODO: binary search for priorKey (maybe missing), then get
      // the one after that. For now we go simple and slow. But cache
      // a starting point, because the main use case is a full
      // iteration. OTOH, the main use case also deletes everything,
      // which will clobber the cache on each deletion, so it might
      // not help.
      const start = priorKeyReturned === priorKey ? priorKeyIndex : 0;
      let result;
      for (let i = start; i < sortedKeys.length; i += 1) {
        const key = sortedKeys[i];
        if (key > priorKey) {
          priorKeyReturned = key;
          priorKeyIndex = i;
          result = key;
          break;
        }
      }
      if (!result) {
        // reached end without finding the key, so clear our cache
        clearGetNextKeyCache();
      }
      return result;
    },
    set(key, value) {
      if (!map.has(key)) {
        clearSorted();
      }
      map.set(key, value);
    },
    delete(key) {
      if (map.has(key)) {
        clearSorted();
      }
      map.delete(key);
    },
  });
  return fakeStore;
}

/**
 * Create a Map backed by a sorted KVStore while keeping the getNextKey method
 * specific to a KVStore making it mostly compatible with both.
 *
 * Iterating over the map while mutating it is "unsupported" (entries inserted
 * that sort before the current iteration point will be skipped).
 *
 * The `size` property is not supported.
 *
 * @param {KVStore} fakeStore
 */
export function makeEnhancedKVStore(fakeStore) {
  /** @type {Omit<KVStore,'set' | 'delete'> & Map<string, string>} */
  const map = harden({
    ...fakeStore,
    set(key, value) {
      fakeStore.set(key, value);
      return map;
    },
    delete(key) {
      const had = fakeStore.has(key);
      fakeStore.delete(key);
      return had;
    },
    clear() {
      for (const key of map.keys()) {
        fakeStore.delete(key);
      }
    },
    /** @returns {number} */
    get size() {
      throw new Error('size not implemented.');
    },
    *entries() {
      for (const key of map.keys()) {
        yield [key, /** @type {string} */ (fakeStore.get(key))];
      }
    },
    *keys() {
      /** @type {string | undefined} */
      let key = '';
      // eslint-disable-next-line no-cond-assign
      while ((key = fakeStore.getNextKey(key))) {
        yield key;
      }
    },
    *values() {
      for (const key of map.keys()) {
        yield /** @type {string} */ (fakeStore.get(key));
      }
    },
    forEach(callbackfn, thisArg) {
      for (const key of map.keys()) {
        Reflect.apply(callbackfn, thisArg, [
          /** @type {string} */ (fakeStore.get(key)),
          key,
          map,
        ]);
      }
    },
    [Symbol.iterator]() {
      return map.entries();
    },
    [Symbol.toStringTag]: 'EnhancedKVStore',
  });
  return map;
}

/**
 *
 * @param {Map<string, string> | KVStore} [mapOrKvStore]
 */
export function provideEnhancedKVStore(mapOrKvStore = new Map()) {
  if (!('getNextKey' in mapOrKvStore)) {
    mapOrKvStore = makeKVStoreFromMap(mapOrKvStore);
  }

  if (!('keys' in mapOrKvStore)) {
    mapOrKvStore = makeEnhancedKVStore(mapOrKvStore);
  }

  return /** @type {ReturnType<typeof makeEnhancedKVStore>} */ (mapOrKvStore);
}

export function makeFakeLiveSlotsStuff(options = {}) {
  let vrm;
  function setVrm(vrmToUse) {
    assert(!vrm, 'vrm already configured');
    vrmToUse.initializeIDCounters();
    vrm = vrmToUse;
  }

  const {
    weak = false,
    log,
    FinalizationRegistry = FakeFinalizationRegistry,
    WeakRef = FakeWeakRef, // VRM uses this
    WeakMap = RealWeakMap,
    WeakSet = RealWeakSet,
    addToPossiblyDeadSet = () => {},
    addToPossiblyRetiredSet = () => {},
  } = options;

  const fakeStore = provideEnhancedKVStore(options.fakeStore);

  function s(v) {
    switch (typeof v) {
      case 'symbol':
        return v.toString();
      case 'bigint':
        return `${v}n`;
      default:
        return `${v}`;
    }
  }

  function dumpStore() {
    return [...fakeStore];
  }

  const syscall = {
    vatstoreGet(key) {
      const result = fakeStore.get(key);
      if (log) {
        log.push(`get ${s(key)} => ${s(result)}`);
      }
      return result;
    },
    vatstoreGetNextKey(priorKey) {
      const result = fakeStore.getNextKey(priorKey);
      if (log) {
        log.push(`getNextKey ${s(priorKey)} => ${s(result)}`);
      }
      return result;
    },
    vatstoreSet(key, value) {
      if (log) {
        log.push(`set ${s(key)} ${s(value)}`);
      }
      fakeStore.set(key, value);
    },
    vatstoreDelete(key) {
      if (log) {
        log.push(`delete ${s(key)}`);
      }
      fakeStore.delete(key);
    },
  };

  function allocateExportID() {
    return vrm.allocateNextID('exportID');
  }

  function allocatePromiseID() {
    return vrm.allocateNextID('promiseID');
  }

  function allocateCollectionID() {
    return vrm.allocateNextID('collectionID');
  }

  // note: The real liveslots slotToVal() maps slots (vrefs) to a WeakRef,
  // and the WeakRef may or may not contain the target value. Use
  // options={weak:true} to match that behavior, or the default weak:false to
  // keep strong references.
  const WeakRefForSlot = weak ? RealWeakRef : FakeWeakRef;
  const valToSlot = new WeakMap();
  const slotToVal = new Map();

  function getSlotForVal(val) {
    return valToSlot.get(val);
  }

  function getValForSlot(slot) {
    const d = slotToVal.get(slot);
    return d && d.deref();
  }

  function requiredValForSlot(slot) {
    const val = getValForSlot(slot);
    assert(val, `${slot} must have a value`);
    return val;
  }

  function setValForSlot(slot, val) {
    slotToVal.set(slot, new WeakRefForSlot(val));
  }

  function convertValToSlot(val) {
    if (!valToSlot.has(val)) {
      const slot = isPromise(val)
        ? `p+${allocatePromiseID()}`
        : `o+${allocateExportID()}`;
      valToSlot.set(val, slot);
      setValForSlot(slot, val);
    }
    return valToSlot.get(val);
  }

  function convertSlotToVal(slot) {
    const { type, id, virtual, durable, facet, baseRef } = parseVatSlot(slot);
    assert.equal(type, 'object');
    let val = getValForSlot(baseRef);
    if (val) {
      if (virtual || durable) {
        if (facet !== undefined) {
          return vrm.getFacet(id, val, facet);
        }
      }
      return val;
    }
    let result;
    if (virtual || durable) {
      if (vrm) {
        val = vrm.reanimate(slot);
        if (facet !== undefined) {
          result = vrm.getFacet(id, val, facet);
        }
      } else {
        assert.fail('fake liveSlots stuff configured without vrm');
      }
    }
    // eslint-disable-next-line no-use-before-define
    registerEntry(baseRef, val, facet !== undefined);
    if (!result) {
      result = val;
    }
    return result;
  }

  const marshal = makeMarshal(convertValToSlot, convertSlotToVal, {
    serializeBodyFormat: 'smallcaps',
    marshalName: 'fakeLiveSlots',
    errorIdNum: 80_000,
    marshalSaveError: _err => {},
  });

  function registerEntry(baseRef, val, valIsCohort) {
    const { facet } = parseVatSlot(baseRef);
    !facet ||
      Fail`registerEntry(${baseRef} should not receive individual facets`;
    setValForSlot(baseRef, val);
    if (valIsCohort) {
      const { id } = parseVatSlot(baseRef);
      for (const [index, name] of vrm.getFacetNames(id).entries()) {
        valToSlot.set(val[name], `${baseRef}:${index}`);
      }
    } else {
      valToSlot.set(val, baseRef);
    }
  }

  function deleteEntry(slot, val) {
    if (!val) {
      val = getValForSlot(slot);
    }
    slotToVal.delete(slot);
    valToSlot.delete(val);
  }

  function assertAcceptableSyscallCapdataSize(_capdatas) {}

  const maybeExportPromise = _vref => false;

  return {
    syscall,
    allocateExportID,
    allocatePromiseID,
    allocateCollectionID,
    getSlotForVal,
    requiredValForSlot,
    getValForSlot,
    setValForSlot,
    registerEntry,
    valToSlot,
    slotToVal,
    convertValToSlot,
    convertSlotToVal,
    marshal,
    deleteEntry,
    FinalizationRegistry,
    WeakRef,
    WeakMap,
    WeakSet,
    addToPossiblyDeadSet,
    addToPossiblyRetiredSet,
    dumpStore,
    setVrm,
    assertAcceptableSyscallCapdataSize,
    maybeExportPromise,
  };
}

export function makeFakeVirtualReferenceManager(
  fakeStuff,
  relaxDurabilityRules = true,
) {
  return makeVirtualReferenceManager(
    fakeStuff.syscall,
    fakeStuff.getSlotForVal,
    fakeStuff.getValForSlot,
    fakeStuff.FinalizationRegistry,
    fakeStuff.WeakRef,
    fakeStuff.addToPossiblyDeadSet,
    fakeStuff.addToPossiblyRetiredSet,
    relaxDurabilityRules,
  );
}

export function makeFakeWatchedPromiseManager(
  vrm,
  vom,
  collectionManager,
  fakeStuff,
) {
  return makeWatchedPromiseManager({
    syscall: fakeStuff.syscall,
    vrm,
    vom,
    collectionManager,
    convertValToSlot: fakeStuff.convertValToSlot,
    convertSlotToVal: fakeStuff.convertSlotToVal,
    maybeExportPromise: fakeStuff.maybeExportPromise,
  });
}

/**
 * Configure virtual stuff with relaxed durability rules and fake liveslots
 *
 * @param {object} [options]
 * @param {number} [options.cacheSize]
 * @param {boolean} [options.relaxDurabilityRules]
 * @param {Map<string, string> | KVStore} [options.fakeStore]
 * @param {WeakMapConstructor} [options.WeakMap]
 * @param {WeakSetConstructor} [options.WeakSet]
 * @param {boolean} [options.weak]
 */
export function makeFakeVirtualStuff(options = {}) {
  const actualOptions = {
    relaxDurabilityRules: true,
    ...options,
  };
  const { relaxDurabilityRules } = actualOptions;
  const fakeStuff = makeFakeLiveSlotsStuff(actualOptions);
  const vrm = makeFakeVirtualReferenceManager(fakeStuff, relaxDurabilityRules);
  fakeStuff.setVrm(vrm);
  const vom = makeFakeVirtualObjectManager(vrm, fakeStuff);
  vom.initializeKindHandleKind();
  const cm = makeFakeCollectionManager(vrm, fakeStuff, actualOptions);
  const wpm = makeFakeWatchedPromiseManager(vrm, vom, cm, fakeStuff);
  wpm.preparePromiseWatcherTables();
  return { fakeStuff, vrm, vom, cm, wpm };
}

export function makeStandaloneFakeVirtualObjectManager(options = {}) {
  const fakeStuff = makeFakeLiveSlotsStuff(options);
  const { relaxDurabilityRules = true } = options;
  const vrm = makeFakeVirtualReferenceManager(fakeStuff, relaxDurabilityRules);
  fakeStuff.setVrm(vrm);
  const vom = makeFakeVirtualObjectManager(vrm, fakeStuff);
  vom.initializeKindHandleKind();
  return vom;
}

export function makeStandaloneFakeCollectionManager(options = {}) {
  const fakeStuff = makeFakeLiveSlotsStuff(options);
  const { relaxDurabilityRules = true } = options;
  const vrm = makeFakeVirtualReferenceManager(fakeStuff, relaxDurabilityRules);
  fakeStuff.setVrm(vrm);
  return makeFakeCollectionManager(vrm, fakeStuff, options);
}

export {
  makeStandaloneFakeVirtualObjectManager as makeFakeVirtualObjectManager,
  makeStandaloneFakeCollectionManager as makeFakeCollectionManager,
};
