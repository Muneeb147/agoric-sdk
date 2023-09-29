import { test } from '../../tools/prepare-test-env-ava.js';

// eslint-disable-next-line import/order
import { Far } from '@endo/marshal';
import {
  setupTestLiveslots,
  matchResolveOne,
  matchVatstoreGet,
  matchVatstoreGetAfter,
  matchVatstoreDelete,
  matchVatstoreSet,
  matchRetireExports,
  matchDropImports,
  matchRetireImports,
  validate,
  validateDone,
  validateReturned,
} from '../liveslots-helpers.js';
import { validateCreateBuiltInTables } from '../gc-helpers.js';
import { capargs } from '../util.js';

// Legs:
//
// Possible retainers of a VO (ensuring continued reachability):
//   L: variable in local memory
//   E: export to kernel (reachable)
//   V: virtual object property (vprop) state
// Additionally, the kernel may remember a VO (ensuring continued recognizability)
//   R: recognizable to kernel
//
// We denote the presence of a leg these via its letter in upper case, its
// absence by the letter in lower case, and "don't care" by ".".
//
// In principle there are 2^4 = 16 conceivable states, but not all are possible.
// States .er.., ..ER.., and .eR.. are possible, but .Er.. is not, since
// reachability always implies recognizability, which reduces the number of
// states to 12.
//
// In addition, any transition into the state leRv implies the loss of
// reachability, which results in the issuance of a `retireExports` syscall,
// resulting in turn to an immediate and automatic transition into state
// lerv. Thus, for purposes of analysis of state transitions driven by events
// *external* to the VO garbage collection machinery, the state leRv does not
// exist and so the state diagram in the model here has 11 states.
//
// The initial state is lerv, which is essentially the state of non-existence.
// The act of creation yields the first local reference to the object and thus
// the first state transition is always to Lerv.
//
// When the state reaches le.v the VO is no longer reachable and may be garbage
// collected.
//
// When the state reaches lerv the VO is no longer recognizable anywhere and
// any weak collection entries that use the VO as a key should be removed.

// There may be more than one local reference, hence L subsumes all states with
// 1 or more, whereas l implies there are 0.  Detection of the transition from L
// to l is handled by a JS finalizer.

// There may be more than one vprop reference, hence V subsumes all states with
// 1 or more, whereas v implies there are 0.  The number of vprop references to
// a virtual object is tracked via explicit reference counting.

// The transitions from E to e and R to r happen as the result of explicit
// deliveries (dropExport and retireExport respectively) from the kernel.  (The
// retireExport syscall does not result in a transition but rather informs the
// kernel of the consequences of a state transition that resulted in loss of
// recognizability.)

// The possible state transitions are:
//   lerv -create-> Lerv  (creation) [1]
//   Ler. -export-> LER.  (export) [2]
//   L..v -vstore-> L..V  (store in vprop) [3]
//
//   L... -droplr-> l...  (drop local reference) [6]
//   lER. -delivr-> LER.  (reacquire local reference via delivery) [2]
//   l..V -readvp-> L..V  (reacquire local reference via read from vprop) [3]
//
//   .ER. -dropex-> .eR.  (d.dropExport) [4]
//   .eR. -retexp-> .er.  (d.retireExport) [3]
//
//   ...V -overwr-> ...v  (overwrite last vprop) [6]
//
// While in the above notation "." denotes "don't care", the legs not cared
// about are always the same in the before and after states of each state
// transition, hence each of the transition patterns above represents 2^N
// transitions, where N is the number of dots on either side of the arrow
// (minus, once again, the excluded Er states).  Since each of these 2^N
// transitions represents a potentially different path through the code, test
// cases must be constructed that exercise each of them.  Although there's a
// total of 30 of state transitions, testing each requires setting up the before
// state, which can be the after state of some earlier transition being tested,
// thus the actual tests consist of a smaller number of manually constructed
// (and somewhat ad hoc) paths through state space that collectively hit all the
// possible state transitions.

// Any transition to lerv from L... or .E.. or ...V should trigger the garbage
// collection of the virtual object.

// Any Transition to lerv (from ..R.) should trigger retirement of the virtual
// object's identity.

//   lerv -create-> Lerv

//   Lerv -export-> LERv
//   LerV -export-> LERV

//   Lerv -vstore-> LerV
//   LeRv -vstore-> LeRV
//   LERv -vstore-> LERV

//   Lerv -droplr-> lerv gc
//   LerV -droplr-> lerV
//   LeRv -droplr-> lerv gc, ret
//   LeRV -droplr-> leRV
//   LERv -droplr-> lERv
//   LERV -droplr-> lERV

//   lERv -delivr-> LERv
//   lERV -delivr-> LERV

//   lerV -readvp-> LerV
//   leRV -readvp-> LeRV
//   lERV -readvp-> LERV

//   lERv -dropex-> lerv gc, ret
//   lERV -dropex-> leRV
//   LERv -dropex-> LeRv
//   LERV -dropex-> LeRV

//   leRV -retexp-> lerV
//   LeRv -retexp-> Lerv
//   LeRV -retexp-> LerV

//   lerV -overwr-> lerv gc
//   leRV -overwr-> lerv gc, ret
//   LerV -overwr-> Lerv
//   LeRV -overwr-> LeRv
//   lERV -overwr-> lERv
//   LERV -overwr-> LERv

let aWeakMap;
let aWeakSet;

function base(vref) {
  if (vref.endsWith(':0') || vref.endsWith(':1')) {
    return vref.substring(0, vref.length - 2);
  } else {
    return vref;
  }
}

function esKey(vref) {
  return `vom.es.${base(vref)}`;
}

function esVal(es, patt) {
  return es ? patt.replace('%', es) : es;
}

function esf(isf) {
  return isf ? 'n%' : '%';
}

function rcKey(vref) {
  return `vom.rc.${base(vref)}`;
}

function stateKey(vref) {
  return `vom.${base(vref)}`;
}

const unfacetedThingKindID = '10';
const unfacetedThingBaseRef = `o+${unfacetedThingKindID}`;
const facetedThingKindID = '11';
const facetedThingBaseRef = `o+${facetedThingKindID}`;
const holderKindID = '12';
const holderBaseRef = `o+${holderKindID}`;
const markerKindID = '13';
const markerBaseRef = `o+${markerKindID}`;

const remotableID = 'o+14';

function thingVref(isf, instance) {
  return `${isf ? facetedThingBaseRef : unfacetedThingBaseRef}/${instance}`;
}

function facetRef(isf, vref, facet) {
  return `${vref}${isf && facet ? `:${facet}` : ''}`;
}

const cacheDisplacerVref = thingVref(false, 1);
const fCacheDisplacerVref = thingVref(true, 1);
const virtualHolderVref = `${holderBaseRef}/1`;

function buildRootObject(vatPowers) {
  const { VatData, WeakMap, WeakSet } = vatPowers;

  const { defineKind, defineKindMulti } = VatData;

  const makeThing = defineKind('thing', label => ({ label }), {
    getLabel: ({ state }) => state.label,
  });
  const makeFacetedThing = defineKindMulti('thing', label => ({ label }), {
    facetA: {
      getLabelA: ({ state }) => state.label,
    },
    facetB: {
      getLabelB: ({ state }) => state.label,
    },
  });
  const cacheDisplacer = makeThing('cacheDisplacer');
  // This immediately goes out of scope and gets GC'd and deleted, but its
  // creation consumes the same subID in its kind as the `cacheDisplacer` that
  // we actually use consumes when *it* is created. This ensures that the
  // creation of both things and faceted things during tests result in the same
  // sequence of subIDs rather than being out of phase by 1
  // eslint-disable-next-line no-unused-vars
  const unusedFacetedCacheDisplacer = makeFacetedThing('cacheDisplacer');

  const makeVirtualHolder = defineKind('holder', (held = null) => ({ held }), {
    setValue: ({ state }, value) => {
      state.held = value;
    },
    getValue: ({ state }) => state.held,
  });
  const virtualHolder = makeVirtualHolder();

  const makeDualMarkerThing = defineKindMulti(
    'marker',
    () => ({ unused: 'uncared for' }),
    {
      facetA: {
        methodA: () => 0,
      },
      facetB: {
        methodB: () => 0,
      },
    },
  );

  let nextThingNumber = 0;
  let heldThing = null;
  aWeakMap = new WeakMap();
  aWeakSet = new WeakSet();

  const holders = [];

  function displaceCache() {
    return cacheDisplacer.getLabel();
  }

  function makeNextThing(isf) {
    const label = `thing #${nextThingNumber}`;
    nextThingNumber += 1;
    if (isf) {
      const { facetB } = makeFacetedThing(label);
      return facetB;
    } else {
      return makeThing(label);
    }
  }

  return Far('root', {
    makeAndHold(isf) {
      heldThing = makeNextThing(isf);
      displaceCache();
    },
    makeAndHoldFacets() {
      heldThing = makeFacetedThing('thing #0');
      displaceCache();
    },
    makeAndHoldDualMarkers() {
      heldThing = makeDualMarkerThing().facetA;
      displaceCache();
    },
    makeAndHoldAndKey(isf) {
      heldThing = makeNextThing(isf);
      aWeakMap.set(heldThing, 'arbitrary');
      aWeakSet.add(heldThing);
      displaceCache();
    },
    makeAndHoldRemotable() {
      heldThing = Far('thing', {});
      displaceCache();
    },
    dropHeld() {
      heldThing = null;
      displaceCache();
    },
    storeHeld() {
      virtualHolder.setValue(heldThing);
      displaceCache();
    },
    dropStored() {
      virtualHolder.setValue(null);
      displaceCache();
    },
    fetchAndHold() {
      heldThing = virtualHolder.getValue();
      displaceCache();
    },
    exportHeld() {
      return heldThing;
    },
    exportHeldA() {
      return heldThing.facetA;
    },
    exportHeldB() {
      return heldThing.facetB;
    },
    importAndHold(thing) {
      heldThing = thing;
      displaceCache();
    },
    importAndHoldAndKey(thing) {
      heldThing = thing;
      aWeakMap.set(heldThing, 'arbitrary');
      aWeakSet.add(heldThing);
      displaceCache();
    },

    prepareStore3() {
      holders.push(makeVirtualHolder(heldThing));
      holders.push(makeVirtualHolder(heldThing));
      holders.push(makeVirtualHolder(heldThing));
      heldThing = null;
      displaceCache();
    },
    finishClearHolders() {
      for (let i = 0; i < holders.length; i += 1) {
        holders[i].setValue(null);
      }
      displaceCache();
    },
    finishDropHolders() {
      for (let i = 0; i < holders.length; i += 1) {
        holders[i] = null;
      }
      displaceCache();
    },
    prepareStoreLinked() {
      let holder = makeVirtualHolder(heldThing);
      holder = makeVirtualHolder(holder);
      holder = makeVirtualHolder(holder);
      holders.push(holder);
      heldThing = null;
      displaceCache();
    },
    noOp() {
      // used when an extra cycle is needed to pump GC
    },
  });
}

function capdata(data, slots = []) {
  return { body: JSON.stringify(data), slots };
}

function thingSer(vref) {
  if (vref) {
    let tag = '';
    if (vref.endsWith(':0')) {
      tag = ' facetA';
    } else if (vref.endsWith(':1')) {
      tag = ' facetB';
    }
    const iface = `Alleged: thing${tag}`;
    return capargs({ '@qclass': 'slot', iface, index: 0 }, [vref]);
  } else {
    return capargs(null, []);
  }
}

function holderSer(vref) {
  if (vref) {
    return capargs({ '@qclass': 'slot', iface: 'Alleged: holder', index: 0 }, [
      vref,
    ]);
  } else {
    return capargs(null, []);
  }
}

function thingArg(vref, isf) {
  if (isf) {
    return [
      {
        '@qclass': 'slot',
        iface: 'Alleged: thing facetB',
        index: 0,
      },
      `${vref}:1`,
    ];
  } else {
    return [{ '@qclass': 'slot', iface: 'Alleged: thing', index: 0 }, vref];
  }
}

function thingValue(label) {
  return JSON.stringify({ label: capdata(label) });
}

function heldThingValue(vref) {
  return JSON.stringify({ held: thingSer(vref) });
}

function heldHolderValue(vref) {
  return JSON.stringify({ held: holderSer(vref) });
}

const testObjValue = thingValue('thing #0');
const cacheObjValue = thingValue('cacheDisplacer');

const NONE = undefined; // mostly just shorter, to maintain legibility while making prettier shut up

function validateDelete(v, vref) {
  validate(v, matchVatstoreDelete(stateKey(vref)));
  validate(v, matchVatstoreDelete(rcKey(vref)));
  validate(v, matchVatstoreDelete(esKey(vref)));
}

function validateStatusCheck(v, vref, rc, es, value) {
  validate(v, matchVatstoreGet(rcKey(vref), rc));
  validate(v, matchVatstoreGet(esKey(vref), es));
  validate(v, matchVatstoreGet(stateKey(vref), value));
}

function validateCheckNoWeakKeys(v, ref) {
  validate(v, matchVatstoreGetAfter('', `vom.ir.${ref}|`, NONE, [NONE, NONE]));
}

function validateFauxCacheDisplacerDeletion(v) {
  validate(v, matchVatstoreSet('idCounters'));
  validate(v, matchVatstoreGet(rcKey(fCacheDisplacerVref), NONE));
  validate(v, matchVatstoreGet(esKey(fCacheDisplacerVref), NONE));
  validate(v, matchVatstoreGet(stateKey(fCacheDisplacerVref), cacheObjValue));
  validateDelete(v, fCacheDisplacerVref);
  validateCheckNoWeakKeys(v, `${fCacheDisplacerVref}:0`);
  validateCheckNoWeakKeys(v, `${fCacheDisplacerVref}:1`);
}

function validateKindMetadata(v, kindID, tag) {
  validate(
    v,
    matchVatstoreSet(
      `vom.vkind.${kindID}`,
      `{"kindID":"${kindID}","tag":"${tag}"}`,
    ),
  );
}

function validateSetup(v) {
  validate(v, matchVatstoreGet('idCounters', NONE));
  validate(v, matchVatstoreGet('kindIDID', NONE));
  validate(v, matchVatstoreSet('kindIDID', '1'));
  validate(v, matchVatstoreGet('storeKindIDTable', NONE));
  validate(
    v,
    matchVatstoreSet(
      'storeKindIDTable',
      '{"scalarMapStore":2,"scalarWeakMapStore":3,"scalarSetStore":4,"scalarWeakSetStore":5,"scalarDurableMapStore":6,"scalarDurableWeakMapStore":7,"scalarDurableSetStore":8,"scalarDurableWeakSetStore":9}',
    ),
  );
  validateCreateBuiltInTables(v);
  validateKindMetadata(v, unfacetedThingKindID, 'thing');
  validateKindMetadata(v, facetedThingKindID, 'thing');
  validate(v, matchVatstoreSet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateKindMetadata(v, holderKindID, 'holder');
  validate(v, matchVatstoreSet(stateKey(fCacheDisplacerVref), cacheObjValue));
  validateKindMetadata(v, markerKindID, 'marker');
  validate(v, matchVatstoreGet('deadPromises', NONE));
  validate(v, matchVatstoreGetAfter('', 'vom.dkind.', NONE, [NONE, NONE]));
  validate(
    v,
    matchVatstoreSet(stateKey(virtualHolderVref), heldThingValue(null)),
  );
}

function validateSetupAndCreate(v, rp, what, heldValue = testObjValue) {
  validateSetup(v);

  // create
  validate(v, matchVatstoreSet(stateKey(what), heldValue));
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);

  // cleanup
  validateFauxCacheDisplacerDeletion(v);
  validateDone(v);
}

function validateStore(v, rp, what, rcBefore) {
  validate(
    v,
    matchVatstoreGet(stateKey(virtualHolderVref), heldThingValue(null)),
  );
  validate(v, matchVatstoreGet(rcKey(what), rcBefore));
  validate(v, matchVatstoreSet(rcKey(what), '1'));
  validate(
    v,
    matchVatstoreSet(stateKey(virtualHolderVref), heldThingValue(what)),
  );
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validateDone(v);
}

function validateDropStored(v, rp, what, esp, postCheck) {
  validate(
    v,
    matchVatstoreGet(stateKey(virtualHolderVref), heldThingValue(what)),
  );
  validate(v, matchVatstoreGet(rcKey(what), '1'));
  validate(v, matchVatstoreSet(rcKey(what), '0'));
  validate(
    v,
    matchVatstoreSet(stateKey(virtualHolderVref), heldThingValue(null)),
  );
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  if (postCheck) {
    validate(v, matchVatstoreGet(rcKey(what), '0'));
    validate(v, matchVatstoreGet(esKey(what), esVal('r', esp)));
  }
  validateDone(v);
}

function validateWeakCheck(v, what) {
  const whatb = base(what);
  if (whatb !== what) {
    validateCheckNoWeakKeys(v, `${whatb}:0`);
    validateCheckNoWeakKeys(v, `${whatb}:1`);
  } else {
    validateCheckNoWeakKeys(v, what);
  }
}

function validateDropStoredAndRetire(v, rp, what) {
  validate(
    v,
    matchVatstoreGet(stateKey(virtualHolderVref), heldThingValue(what)),
  );
  validate(v, matchVatstoreGet(rcKey(what), '1'));
  validate(v, matchVatstoreSet(rcKey(what), '0'));
  validate(
    v,
    matchVatstoreSet(stateKey(virtualHolderVref), heldThingValue(null)),
  );
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validateStatusCheck(v, what, '0', NONE, testObjValue);
  validateDelete(v, what);
  validateWeakCheck(v, what);
  validateDone(v);
}

function validateDropStoredWithGCAndRetire(v, rp, what, esp) {
  validate(
    v,
    matchVatstoreGet(stateKey(virtualHolderVref), heldThingValue(what)),
  );
  validate(v, matchVatstoreGet(rcKey(what), '1'));
  validate(v, matchVatstoreSet(rcKey(what), '0'));
  validate(
    v,
    matchVatstoreSet(stateKey(virtualHolderVref), heldThingValue(null)),
  );
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validateStatusCheck(v, what, '0', esVal('s', esp), testObjValue);
  validateDelete(v, what);
  validateWeakCheck(v, what);
  validate(v, matchRetireExports(what));
  validateDone(v);
}

function validateExport(v, rp, what, esp, second) {
  if (!second) {
    validate(v, matchVatstoreGet(esKey(what), NONE));
  } else {
    validate(v, matchVatstoreGet(esKey(what), esVal('n', esp)));
  }
  validate(v, matchVatstoreSet(esKey(what), esVal('r', esp)));
  validate(v, matchResolveOne(rp, thingSer(what)));
  validateDone(v);
}

function validateImport(v, rp, what, whatValue) {
  validate(v, matchVatstoreGet(stateKey(what), whatValue));
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validateDone(v);
}

function validateLoad(v, rp, what, whatValue) {
  validate(
    v,
    matchVatstoreGet(stateKey(virtualHolderVref), heldThingValue(what)),
  );
  validate(v, matchVatstoreGet(stateKey(what), whatValue));
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validateDone(v);
}

function validateDropHeld(v, rp, what, esp, rc, es) {
  validateReturned(v, rp);
  validate(v, matchVatstoreGet(rcKey(what), rc));
  validate(v, matchVatstoreGet(esKey(what), esVal(es, esp)));
  validateDone(v);
}

function validateDropHeldWithGC(v, rp, what, rc, heldValue = testObjValue) {
  validateReturned(v, rp);
  validateStatusCheck(v, what, rc, NONE, heldValue);
  validateDelete(v, what);
  validateWeakCheck(v, what);
  validateDone(v);
}

function validateDropHeldWithGCAndRetire(v, rp, what, esp) {
  validateReturned(v, rp);
  validateStatusCheck(v, what, NONE, esVal('s', esp), testObjValue);
  validateDelete(v, what);
  validateWeakCheck(v, what);
  validate(v, matchRetireExports(what));
  validateDone(v);
}

function validateDropHeldWithGCAndRetireFacets(v, rp, what, esp) {
  validateReturned(v, rp);
  validateStatusCheck(v, what, NONE, esp, testObjValue);
  validateDelete(v, what);
  validateWeakCheck(v, `${what}:0`);
  validate(v, matchRetireExports(`${what}:0`, `${what}:1`));
  validateDone(v);
}

function validateDropExport(v, what, esp, rc) {
  validate(v, matchVatstoreGet(esKey(what), esVal('r', esp)));
  validate(v, matchVatstoreSet(esKey(what), esVal('s', esp)));
  validate(v, matchVatstoreGet(rcKey(what), rc));
  validateDone(v);
}

function validateDropExportWithGCAndRetire(v, what, esp, rc) {
  validate(v, matchVatstoreGet(esKey(what), esVal('r', esp)));
  validate(v, matchVatstoreSet(esKey(what), esVal('s', esp)));
  validate(v, matchVatstoreGet(rcKey(what), rc));
  validateStatusCheck(v, what, rc, esVal('s', esp), testObjValue);
  validateDelete(v, what);
  validateWeakCheck(v, what);
  validate(v, matchRetireExports(what));
  validateDone(v);
}

function validateRetireExport(v, what, esp) {
  validate(v, matchVatstoreGet(esKey(what), esVal('s', esp)));
  validate(v, matchVatstoreDelete(esKey(what)));
  validateDone(v);
}

// NOTE: these tests must be run serially, since they share a heap and garbage
// collection during one test can interfere with the deterministic behavior of a
// different test.

// test 1: lerv -> Lerv -> LerV -> Lerv -> lerv
async function voLifeCycleTest1(t, isf) {
  const { v, dispatchMessage } = await setupTestLiveslots(
    t,
    buildRootObject,
    'bob',
    true,
  );
  const thing = thingVref(isf, 2);
  const thingf = facetRef(isf, thing, '1');

  // lerv -> Lerv  Create VO
  let rp = await dispatchMessage('makeAndHold', [isf]);
  validateSetupAndCreate(v, rp, thing);

  // Lerv -> LerV  Store VO reference virtually
  rp = await dispatchMessage('storeHeld');
  validateStore(v, rp, thingf);

  // LerV -> Lerv  Overwrite virtual reference
  rp = await dispatchMessage('dropStored');
  validateDropStored(v, rp, thingf, esf(isf), false);

  // Lerv -> lerv  Drop in-memory reference, unreferenced VO gets GC'd
  rp = await dispatchMessage('dropHeld');
  validateDropHeldWithGC(v, rp, thingf, '0');
}
test.serial('VO lifecycle 1 unfaceted', async t => {
  await voLifeCycleTest1(t, false);
});
test.serial('VO lifecycle 1 faceted', async t => {
  await voLifeCycleTest1(t, true);
});

// test 2: lerv -> Lerv -> LerV -> lerV -> LerV -> LERV -> lERV -> LERV ->
//   lERV -> LERV -> lERV -> leRV -> LeRV -> leRV -> LeRV -> LerV
async function voLifeCycleTest2(t, isf) {
  const { v, dispatchMessage, dispatchDropExports, dispatchRetireExports } =
    await setupTestLiveslots(t, buildRootObject, 'bob', true);
  const thing = thingVref(isf, 2);
  const thingf = facetRef(isf, thing, '1');

  // lerv -> Lerv  Create VO
  let rp = await dispatchMessage('makeAndHold', [isf]);
  validateSetupAndCreate(v, rp, thing);

  // Lerv -> LerV  Store VO reference virtually (permanent for now)
  rp = await dispatchMessage('storeHeld');
  validateStore(v, rp, thingf);

  // LerV -> lerV  Drop in-memory reference, no GC because virtual reference
  rp = await dispatchMessage('dropHeld');
  validateDropHeld(v, rp, thing, esf(isf), '1', NONE);

  // lerV -> LerV  Read virtual reference, now there's an in-memory reference again too
  rp = await dispatchMessage('fetchAndHold');
  validateLoad(v, rp, thingf, testObjValue);

  // LerV -> LERV  Export the reference, now all three legs hold it
  rp = await dispatchMessage('exportHeld');
  validateExport(v, rp, thingf, esf(isf));

  // LERV -> lERV  Drop the in-memory reference again, but it's still exported and virtual referenced
  rp = await dispatchMessage('dropHeld');
  validateDropHeld(v, rp, thing, esf(isf), '1', 'r');

  // lERV -> LERV  Reread from storage, all three legs again
  rp = await dispatchMessage('fetchAndHold');
  validateLoad(v, rp, thingf, testObjValue);

  // LERV -> lERV  Drop in-memory reference (stepping stone to other states)
  rp = await dispatchMessage('dropHeld');
  validateDropHeld(v, rp, thing, esf(isf), '1', 'r');

  // lERV -> LERV  Reintroduce the in-memory reference via message
  const [targ, tslot] = thingArg(thing, isf);
  rp = await dispatchMessage('importAndHold', [targ], [tslot]);
  validateImport(v, rp, thingf, testObjValue);

  // LERV -> lERV  Drop in-memory reference
  rp = await dispatchMessage('dropHeld');
  validateDropHeld(v, rp, thing, esf(isf), '1', 'r');

  // lERV -> leRV  Drop the export
  await dispatchDropExports(thingf);
  validateDropExport(v, thing, esf(isf), '1');

  // leRV -> LeRV  Fetch from storage
  rp = await dispatchMessage('fetchAndHold');
  validateLoad(v, rp, thingf, testObjValue);

  // LeRV -> leRV  Forget about it *again*
  rp = await dispatchMessage('dropHeld');
  validateDropHeld(v, rp, thing, esf(isf), '1', 's');

  // leRV -> LeRV  Fetch from storage *again*
  rp = await dispatchMessage('fetchAndHold');
  validateLoad(v, rp, thingf, testObjValue);

  // LeRV -> LerV  Retire the export
  await dispatchRetireExports(thingf);
  validateRetireExport(v, thing, esf(isf));
}
test.serial('VO lifecycle 2 unfaceted', async t => {
  await voLifeCycleTest2(t, false);
});
test.serial('VO lifecycle 2 faceted', async t => {
  await voLifeCycleTest2(t, true);
});

// test 3: lerv -> Lerv -> LerV -> LERV -> LeRV -> leRV -> lerV -> lerv
async function voLifeCycleTest3(t, isf) {
  const { v, dispatchMessage, dispatchDropExports, dispatchRetireExports } =
    await setupTestLiveslots(t, buildRootObject, 'bob', true);
  const thing = thingVref(isf, 2);
  const thingf = facetRef(isf, thing, '1');

  // lerv -> Lerv  Create VO
  let rp = await dispatchMessage('makeAndHold', [isf]);
  validateSetupAndCreate(v, rp, thing);

  // Lerv -> LerV  Store VO reference virtually (permanent for now)
  rp = await dispatchMessage('storeHeld');
  validateStore(v, rp, thingf);

  // LerV -> LERV  Export the reference, now all three legs hold it
  rp = await dispatchMessage('exportHeld');
  validateExport(v, rp, thingf, esf(isf));

  // LERV -> LeRV  Drop the export
  await dispatchDropExports(thingf);
  validateDropExport(v, thing, esf(isf), '1');

  // LeRV -> leRV  Drop in-memory reference
  rp = await dispatchMessage('dropHeld');
  validateDropHeld(v, rp, thing, esf(isf), '1', 's');

  // leRV -> lerV  Retire the export
  await dispatchRetireExports(thingf);
  validateRetireExport(v, thing, esf(isf));

  // lerV -> lerv  Drop stored reference (gc and retire)
  rp = await dispatchMessage('dropStored');
  validateDropStoredAndRetire(v, rp, thingf);
}
test.serial('VO lifecycle 3 unfaceted', async t => {
  await voLifeCycleTest3(t, false);
});
test.serial('VO lifecycle 3 faceted', async t => {
  await voLifeCycleTest3(t, true);
});

// test 4: lerv -> Lerv -> LERv -> LeRv -> lerv
async function voLifeCycleTest4(t, isf) {
  const { v, dispatchMessage, dispatchDropExports } = await setupTestLiveslots(
    t,
    buildRootObject,
    'bob',
    true,
  );
  const thing = thingVref(isf, 2);
  const thingf = facetRef(isf, thing, '1');

  // lerv -> Lerv  Create VO
  let rp = await dispatchMessage('makeAndHold', [isf]);
  validateSetupAndCreate(v, rp, thing);

  // Lerv -> LERv  Export the reference, now two legs hold it
  rp = await dispatchMessage('exportHeld');
  validateExport(v, rp, thingf, esf(isf));

  // LERv -> LeRv  Drop the export
  await dispatchDropExports(thingf);
  validateDropExport(v, thing, esf(isf), NONE);

  // LeRv -> lerv  Drop in-memory reference (gc and retire)
  rp = await dispatchMessage('dropHeld');
  validateDropHeldWithGCAndRetire(v, rp, thingf, esf(isf));
}
test.serial('VO lifecycle 4 unfaceted', async t => {
  await voLifeCycleTest4(t, false);
});
test.serial('VO lifecycle 4 faceted', async t => {
  await voLifeCycleTest4(t, true);
});

// test 5: lerv -> Lerv -> LERv -> LeRv -> Lerv -> lerv
async function voLifeCycleTest5(t, isf) {
  const { v, dispatchMessage, dispatchDropExports, dispatchRetireExports } =
    await setupTestLiveslots(t, buildRootObject, 'bob', true);
  const thing = thingVref(isf, 2);
  const thingf = facetRef(isf, thing, '1');

  // lerv -> Lerv  Create VO
  let rp = await dispatchMessage('makeAndHold', [isf]);
  validateSetupAndCreate(v, rp, thing);

  // Lerv -> LERv  Export the reference, now all three legs hold it
  rp = await dispatchMessage('exportHeld');
  validateExport(v, rp, thingf, esf(isf));

  // LERv -> LeRv  Drop the export
  await dispatchDropExports(thingf);
  validateDropExport(v, thing, esf(isf), NONE);

  // LeRv -> Lerv  Retire the export
  await dispatchRetireExports(thingf);
  validateRetireExport(v, thing, esf(isf));

  // Lerv -> lerv  Drop in-memory reference, unreferenced VO gets GC'd
  rp = await dispatchMessage('dropHeld');
  validateDropHeldWithGC(v, rp, thingf, NONE);
}
test.serial('VO lifecycle 5 unfaceted', async t => {
  await voLifeCycleTest5(t, false);
});
test.serial('VO lifecycle 5 faceted', async t => {
  await voLifeCycleTest5(t, true);
});

// test 6: lerv -> Lerv -> LERv -> LeRv -> LeRV -> LeRv -> LeRV -> leRV -> lerv
async function voLifeCycleTest6(t, isf) {
  const { v, dispatchMessage, dispatchDropExports } = await setupTestLiveslots(
    t,
    buildRootObject,
    'bob',
    true,
  );
  const thing = thingVref(isf, 2);
  const thingf = facetRef(isf, thing, '1');

  // lerv -> Lerv  Create VO
  let rp = await dispatchMessage('makeAndHold', [isf]);
  validateSetupAndCreate(v, rp, thing);

  // Lerv -> LERv  Export the reference, now all three legs hold it
  rp = await dispatchMessage('exportHeld');
  validateExport(v, rp, thingf, esf(isf));

  // LERv -> LeRv  Drop the export
  await dispatchDropExports(thingf);
  validateDropExport(v, thing, esf(isf), NONE);

  // LeRv -> LeRV  Store VO reference virtually
  rp = await dispatchMessage('storeHeld');
  validateStore(v, rp, thingf);

  // LeRV -> LeRv  Overwrite virtual reference
  rp = await dispatchMessage('dropStored');
  validateDropStored(v, rp, thingf, esf(isf), false);

  // LeRv -> LeRV  Store VO reference virtually again
  rp = await dispatchMessage('storeHeld');
  validateStore(v, rp, thingf, '0');

  // LeRV -> leRV  Drop in-memory reference
  rp = await dispatchMessage('dropHeld');
  validateDropHeld(v, rp, thing, esf(isf), '1', 's');

  // leRV -> lerv  Drop stored reference (gc and retire)
  rp = await dispatchMessage('dropStored');
  validateDropStoredWithGCAndRetire(v, rp, thingf, esf(isf));
}
test.serial('VO lifecycle 6 unfaceted', async t => {
  await voLifeCycleTest6(t, false);
});
test.serial('VO lifecycle 6 faceted', async t => {
  await voLifeCycleTest6(t, true);
});

// test 7: lerv -> Lerv -> LERv -> lERv -> LERv -> lERv -> lerv
async function voLifeCycleTest7(t, isf) {
  const { v, dispatchMessage, dispatchDropExports } = await setupTestLiveslots(
    t,
    buildRootObject,
    'bob',
    true,
  );
  const thing = thingVref(isf, 2);
  const thingf = facetRef(isf, thing, '1');

  // lerv -> Lerv  Create VO
  let rp = await dispatchMessage('makeAndHold', [isf]);
  validateSetupAndCreate(v, rp, thing);

  // Lerv -> LERv  Export the reference, now all three legs hold it
  rp = await dispatchMessage('exportHeld');
  validateExport(v, rp, thingf, esf(isf));

  // LERv -> lERv  Drop in-memory reference, no GC because exported
  rp = await dispatchMessage('dropHeld');
  validateDropHeld(v, rp, thing, esf(isf), NONE, 'r');

  // lERv -> LERv  Reintroduce the in-memory reference via message
  const [targ, tslot] = thingArg(thing, isf);
  rp = await dispatchMessage('importAndHold', [targ], [tslot]);
  validateImport(v, rp, thingf, testObjValue);

  // LERv -> lERv  Drop in-memory reference again, still no GC because exported
  rp = await dispatchMessage('dropHeld');
  validateDropHeld(v, rp, thing, esf(isf), NONE, 'r');

  // lERv -> lerv  Drop the export (gc and retire)
  await dispatchDropExports(thingf);
  validateDropExportWithGCAndRetire(v, thingf, esf(isf), NONE);
}
test.serial('VO lifecycle 7 unfaceted', async t => {
  await voLifeCycleTest7(t, false);
});
test.serial('VO lifecycle 7 faceted', async t => {
  await voLifeCycleTest7(t, true);
});

// test 8: lerv -> Lerv -> LERv -> LERV -> LERv -> LERV -> lERV -> lERv -> lerv
async function voLifeCycleTest8(t, isf) {
  const { v, dispatchMessage, dispatchDropExports } = await setupTestLiveslots(
    t,
    buildRootObject,
    'bob',
    true,
  );
  const thing = thingVref(isf, 2);
  const thingf = facetRef(isf, thing, '1');

  // lerv -> Lerv  Create VO
  let rp = await dispatchMessage('makeAndHold', [isf]);
  validateSetupAndCreate(v, rp, thing);

  // Lerv -> LERv  Export the reference
  rp = await dispatchMessage('exportHeld');
  validateExport(v, rp, thingf, esf(isf));

  // LERv -> LERV  Store VO reference virtually
  rp = await dispatchMessage('storeHeld');
  validateStore(v, rp, thingf, NONE);

  // LERV -> LERv  Overwrite virtual reference
  rp = await dispatchMessage('dropStored');
  validateDropStored(v, rp, thingf, esf(isf), false);

  // LERv -> LERV  Store VO reference virtually
  rp = await dispatchMessage('storeHeld');
  validateStore(v, rp, thingf, '0');

  // LERV -> lERV  Drop the in-memory reference
  rp = await dispatchMessage('dropHeld');
  validateDropHeld(v, rp, thing, esf(isf), '1', 'r');

  // lERV -> lERv  Overwrite virtual reference
  rp = await dispatchMessage('dropStored');
  validateDropStored(v, rp, thingf, esf(isf), true);

  // lERv -> lerv  Drop the export (gc and retire)
  await dispatchDropExports(thingf);
  validateDropExportWithGCAndRetire(v, thingf, esf(isf), '0');
}
test.serial('VO lifecycle 8 unfaceted', async t => {
  await voLifeCycleTest8(t, false);
});
test.serial('VO lifecycle 8 faceted', async t => {
  await voLifeCycleTest8(t, true);
});

// multifacet export test 1: no export
test.serial('VO multifacet export 1', async t => {
  const { v, dispatchMessage } = await setupTestLiveslots(
    t,
    buildRootObject,
    'bob',
    true,
  );
  const thing = `${facetedThingBaseRef}/2`;
  const thingf = `${thing}:0`;

  // lerv -> Lerv  Create facets
  let rp = await dispatchMessage('makeAndHoldFacets');
  validateSetupAndCreate(v, rp, thing);

  // Lerv -> lerv  Drop in-memory reference to both facets, unreferenced VO gets GC'd
  rp = await dispatchMessage('dropHeld');
  validateDropHeldWithGC(v, rp, thingf, NONE);

  validateDone(v);
});

// multifacet export test 2a: export A, drop A, retire A
test.serial('VO multifacet export 2a', async t => {
  const { v, dispatchMessage, dispatchDropExports } = await setupTestLiveslots(
    t,
    buildRootObject,
    'bob',
    true,
  );
  const thing = `${facetedThingBaseRef}/2`;
  const thingA = `${thing}:0`;

  // lerv -> Lerv  Create facets
  let rp = await dispatchMessage('makeAndHoldFacets');
  validateSetupAndCreate(v, rp, thing);

  // Lerv -> LE(A)R(A)v  Export facet A
  rp = await dispatchMessage('exportHeldA');
  validateExport(v, rp, thingA, '%n');

  // LE(A)R(A)v -> LeR(A)v  Drop the export of A
  await dispatchDropExports(thingA);
  validateDropExport(v, thingA, '%n', NONE);

  // LeR(A)v -> lerv  Drop in-memory reference to both facets (gc and retire)
  rp = await dispatchMessage('dropHeld');
  validateDropHeldWithGCAndRetire(v, rp, thingA, '%n');
});

// multifacet export test 2b: export B, drop B, retire B
test.serial('VO multifacet export 2b', async t => {
  const { v, dispatchMessage, dispatchDropExports } = await setupTestLiveslots(
    t,
    buildRootObject,
    'bob',
    true,
  );
  const thing = `${facetedThingBaseRef}/2`;
  const thingB = `${thing}:1`;

  // lerv -> Lerv  Create facets
  let rp = await dispatchMessage('makeAndHoldFacets');
  validateSetupAndCreate(v, rp, thing);

  // Lerv -> LE(B)R(B)v  Export facet B
  rp = await dispatchMessage('exportHeldB');
  validateExport(v, rp, thingB, 'n%');

  // LE(B)R(B)v -> LeR(B)v  Drop the export of B
  await dispatchDropExports(thingB);
  validateDropExport(v, thingB, 'n%', NONE);

  // LeR(B)v -> lerv  Drop in-memory reference to both facets (gc and retire)
  rp = await dispatchMessage('dropHeld');
  validateDropHeldWithGCAndRetire(v, rp, thingB, 'n%');
});

// multifacet export test 3abba: export A, export B, drop B, drop A, retire
test.serial('VO multifacet export 3abba', async t => {
  const { v, dispatchMessage, dispatchDropExports } = await setupTestLiveslots(
    t,
    buildRootObject,
    'bob',
    true,
  );
  const thing = `${facetedThingBaseRef}/2`;
  const thingA = `${thing}:0`;
  const thingB = `${thing}:1`;

  // lerv -> Lerv  Create facets
  let rp = await dispatchMessage('makeAndHoldFacets');
  validateSetupAndCreate(v, rp, thing);

  // Lerv -> LE(A)R(A)v  Export facet A
  rp = await dispatchMessage('exportHeldA');
  validateExport(v, rp, thingA, '%n');

  // LE(A)R(A)v -> LE(AB)R(AB)v  Export facet B
  rp = await dispatchMessage('exportHeldB');
  validateExport(v, rp, thingB, 'r%', true);

  // LE(AB)R(AB)v -> LE(A)R(AB)v  Drop the export of B
  await dispatchDropExports(thingB);
  validateDropExport(v, thingB, 'r%', NONE);

  // L(A)R(AB)v -> LeR(AB)v  Drop the export of A
  await dispatchDropExports(thingA);
  validateDropExport(v, thingB, '%s', NONE);

  // LeR(A)v -> lerv  Drop in-memory reference to both facets (gc and retire)
  rp = await dispatchMessage('dropHeld');
  validateDropHeldWithGCAndRetireFacets(v, rp, thing, 'ss');
});

// multifacet export test 3abab: export A, export B, drop A, drop B, retire
test.serial('VO multifacet export 3abab', async t => {
  const { v, dispatchMessage, dispatchDropExports } = await setupTestLiveslots(
    t,
    buildRootObject,
    'bob',
    true,
  );
  const thing = `${facetedThingBaseRef}/2`;
  const thingA = `${thing}:0`;
  const thingB = `${thing}:1`;

  // lerv -> Lerv  Create facets
  let rp = await dispatchMessage('makeAndHoldFacets');
  validateSetupAndCreate(v, rp, thing);

  // Lerv -> LE(A)R(A)v  Export facet A
  rp = await dispatchMessage('exportHeldA');
  validateExport(v, rp, thingA, '%n');

  // LE(A)R(A)v -> LE(AB)R(AB)v  Export facet B
  rp = await dispatchMessage('exportHeldB');
  validateExport(v, rp, thingB, 'r%', true);

  // LE(AB)R(AB)v -> LE(B)R(AB)v  Drop the export of A
  await dispatchDropExports(thingA);
  validateDropExport(v, thingB, '%r', NONE);

  // L(B)R(AB)v -> LeR(AB)v  Drop the export of B
  await dispatchDropExports(thingB);
  validateDropExport(v, thingB, 's%', NONE);

  // LeR(B)v -> lerv  Drop in-memory reference to both facets (gc and retire)
  rp = await dispatchMessage('dropHeld');
  validateDropHeldWithGCAndRetireFacets(v, rp, thing, 'ss');
});

test.serial('VO multifacet markers only', async t => {
  const { v, dispatchMessage } = await setupTestLiveslots(
    t,
    buildRootObject,
    'bob',
    true,
  );
  const thing = `${markerBaseRef}/1`;
  const thingf = `${markerBaseRef}/1:0`;
  const thingCapdata = JSON.stringify({ unused: capdata('uncared for') });

  // lerv -> Lerv  Create facets
  let rp = await dispatchMessage('makeAndHoldDualMarkers');
  validateSetupAndCreate(v, rp, thing, thingCapdata);

  // Lerv -> lerv  Drop in-memory reference, unreferenced VO gets GC'd
  rp = await dispatchMessage('dropHeld');
  validateDropHeldWithGC(v, rp, thingf, NONE, thingCapdata);
});

// prettier-ignore
function validatePrepareStore3(v, rp, isf) {
  const thing = facetRef(isf, thingVref(isf, 2), '1');
  validate(v, matchVatstoreGet(rcKey(thing)));
  validate(v, matchVatstoreSet(rcKey(thing), '1'));
  validate(v, matchVatstoreGet(rcKey(thing), '1'));
  validate(v, matchVatstoreSet(rcKey(thing), '2'));
  validate(v, matchVatstoreSet(stateKey(`${holderBaseRef}/2`), heldThingValue(thing)));
  validate(v, matchVatstoreGet(rcKey(thing), '2'));
  validate(v, matchVatstoreSet(rcKey(thing), '3'));
  validate(v, matchVatstoreSet(stateKey(`${holderBaseRef}/3`), heldThingValue(thing)));
  validate(v, matchVatstoreSet(stateKey(`${holderBaseRef}/4`), heldThingValue(thing)));
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validate(v, matchVatstoreGet(rcKey(thing), '3'));
  validate(v, matchVatstoreGet(esKey(thing), NONE));
  validateDone(v);
}

// prettier-ignore
async function voRefcountManagementTest1(t, isf) {
  const { v, dispatchMessage } = await setupTestLiveslots(t, buildRootObject, 'bob', true);
  const thing = thingVref(isf, 2);
  const thingf = facetRef(isf, thing, '1');

  let rp = await dispatchMessage('makeAndHold', [isf]);
  validateSetupAndCreate(v, rp, thing);

  rp = await dispatchMessage('prepareStore3');
  validatePrepareStore3(v, rp, isf);

  rp = await dispatchMessage('finishClearHolders');
  validate(v, matchVatstoreGet(stateKey(`${holderBaseRef}/2`), heldThingValue(thingf)));
  validate(v, matchVatstoreGet(rcKey(thing), '3'));
  validate(v, matchVatstoreSet(rcKey(thing), '2'));
  validate(v, matchVatstoreSet(stateKey(`${holderBaseRef}/2`), heldThingValue(null)));
  validate(v, matchVatstoreGet(stateKey(`${holderBaseRef}/3`), heldThingValue(thingf)));
  validate(v, matchVatstoreGet(rcKey(thing), '2'));
  validate(v, matchVatstoreSet(rcKey(thing), '1'));
  validate(v, matchVatstoreSet(stateKey(`${holderBaseRef}/3`), heldThingValue(null)));
  validate(v, matchVatstoreGet(stateKey(`${holderBaseRef}/4`), heldThingValue(thingf)));
  validate(v, matchVatstoreGet(rcKey(thing), '1'));
  validate(v, matchVatstoreSet(rcKey(thing), '0'));
  validate(v, matchVatstoreSet(stateKey(`${holderBaseRef}/4`), heldThingValue(null)));
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validateStatusCheck(v, thing, '0', NONE, testObjValue);
  validateDelete(v, thing);
  validateWeakCheck(v, thingf);
  validateDone(v);
}
test.serial('VO refcount management 1 unfaceted', async t => {
  await voRefcountManagementTest1(t, false);
});
test.serial('VO refcount management 1 faceted', async t => {
  await voRefcountManagementTest1(t, true);
});

// prettier-ignore
async function voRefcountManagementTest2(t, isf) {
  const { v, dispatchMessage } = await setupTestLiveslots(t, buildRootObject, 'bob', true);
  const thing = thingVref(isf, 2);
  const thingf = facetRef(isf, thing, '1');

  let rp = await dispatchMessage('makeAndHold', [isf]);
  validateSetupAndCreate(v, rp, thing);

  rp = await dispatchMessage('prepareStore3');
  validatePrepareStore3(v, rp, isf);

  rp = await dispatchMessage('finishDropHolders');
  validateReturned(v, rp);

  const holder2 = `${holderBaseRef}/2`;
  validateStatusCheck(v, holder2, NONE, NONE, heldThingValue(thingf));
  validate(v, matchVatstoreGet(rcKey(thing), '3'));
  validate(v, matchVatstoreSet(rcKey(thing), '2'));
  validateDelete(v, holder2);
  validateWeakCheck(v, holder2);

  const holder3 = `${holderBaseRef}/3`;
  validateStatusCheck(v, holder3, NONE, NONE, heldThingValue(thingf));
  validate(v, matchVatstoreGet(rcKey(thing), '2'));
  validate(v, matchVatstoreSet(rcKey(thing), '1'));
  validateDelete(v, holder3);
  validateWeakCheck(v, holder3);

  const holder4 = `${holderBaseRef}/4`;
  validateStatusCheck(v, holder4, NONE, NONE, heldThingValue(thingf));
  validate(v, matchVatstoreGet(rcKey(thing), '1'));
  validate(v, matchVatstoreSet(rcKey(thing), '0'));
  validateDelete(v, holder4);
  validateWeakCheck(v, holder4);

  validateStatusCheck(v, thing, '0', NONE, testObjValue);
  validateDelete(v, thing);
  validateWeakCheck(v, thingf);

  validateDone(v);
}
test.serial('VO refcount management 2 unfaceted', async t => {
  await voRefcountManagementTest2(t, false);
});
test.serial('VO refcount management 2 faceted', async t => {
  await voRefcountManagementTest2(t, true);
});

// prettier-ignore
async function voRefcountManagementTest3(t, isf) {
  const { v, dispatchMessage } = await setupTestLiveslots(t, buildRootObject, 'bob', true);
  const thing = thingVref(isf, 2);
  const thingf = facetRef(isf, thing, '1');

  let rp = await dispatchMessage('makeAndHold', [isf]);
  validateSetupAndCreate(v, rp, thing);

  rp = await dispatchMessage('prepareStoreLinked');
  validate(v, matchVatstoreGet(rcKey(thing)));
  validate(v, matchVatstoreSet(rcKey(thing), '1'));
  const holder2 = `${holderBaseRef}/2`;
  validate(v, matchVatstoreGet(rcKey(holder2)));
  validate(v, matchVatstoreSet(rcKey(holder2), '1'));
  validate(v, matchVatstoreSet(stateKey(holder2), heldThingValue(thingf)));
  const holder3 = `${holderBaseRef}/3`;
  validate(v, matchVatstoreGet(rcKey(holder3)));
  validate(v, matchVatstoreSet(rcKey(holder3), '1'));
  validate(v, matchVatstoreSet(stateKey(holder3), heldHolderValue(holder2)));
  const holder4 = `${holderBaseRef}/4`;
  validate(v, matchVatstoreSet(stateKey(holder4), heldHolderValue(holder3)));
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validate(v, matchVatstoreGet(rcKey(thing), '1'));
  validate(v, matchVatstoreGet(esKey(thing), NONE));

  validate(v, matchVatstoreGet(rcKey(holder2), '1'));
  validate(v, matchVatstoreGet(esKey(holder2), NONE));
  validate(v, matchVatstoreGet(rcKey(holder3), '1'));
  validate(v, matchVatstoreGet(esKey(holder3), NONE));
  validateDone(v);

  rp = await dispatchMessage('finishDropHolders');
  validateReturned(v, rp);
  validateStatusCheck(v, holder4, NONE, NONE, heldHolderValue(holder3));
  validate(v, matchVatstoreGet(rcKey(holder3), '1'));
  validate(v, matchVatstoreSet(rcKey(holder3), '0'));

  validateDelete(v, holder4);
  validateWeakCheck(v, holder4);

  validateStatusCheck(v, holder3, '0', NONE, heldHolderValue(holder2));
  validate(v, matchVatstoreGet(rcKey(holder2), '1'));
  validate(v, matchVatstoreSet(rcKey(holder2), '0'));
  validateDelete(v, holder3);
  validateWeakCheck(v, holder3);

  validateStatusCheck(v, holder2, '0', NONE, heldThingValue(thingf));
  validate(v, matchVatstoreGet(rcKey(thing), '1'));
  validate(v, matchVatstoreSet(rcKey(thing), '0'));
  validateDelete(v, holder2);
  validateWeakCheck(v, holder2);

  validateStatusCheck(v, thing, '0', NONE, testObjValue);
  validateDelete(v, thing);
  validateWeakCheck(v, thingf);

  validateDone(v);
}
test.serial('VO refcount management 3 unfaceted', async t => {
  await voRefcountManagementTest3(t, false);
});
test.serial('VO refcount management 3 faceted', async t => {
  await voRefcountManagementTest3(t, true);
});

// prettier-ignore
test.serial('presence refcount management 1', async t => {
  const { v, dispatchMessage } = await setupTestLiveslots(t, buildRootObject, 'bob', true);

  const presRef = 'o-5';
  const [targ, tslot] = thingArg(presRef);
  let rp = await dispatchMessage('importAndHold', [targ], [tslot]);
  validateSetup(v);
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validateFauxCacheDisplacerDeletion(v);
  validateDone(v);

  rp = await dispatchMessage('prepareStore3');
  validate(v, matchVatstoreGet(rcKey(presRef)));
  validate(v, matchVatstoreSet(rcKey(presRef), '1'));
  validate(v, matchVatstoreGet(rcKey(presRef), '1'));
  validate(v, matchVatstoreSet(rcKey(presRef), '2'));
  const holder2 = `${holderBaseRef}/2`;
  validate(v, matchVatstoreSet(stateKey(holder2), heldThingValue(presRef)));
  validate(v, matchVatstoreGet(rcKey(presRef), '2'));
  validate(v, matchVatstoreSet(rcKey(presRef), '3'));
  const holder3 = `${holderBaseRef}/3`;
  validate(v, matchVatstoreSet(stateKey(holder3), heldThingValue(presRef)));
  validate(v, matchVatstoreSet(stateKey(`${holderBaseRef}/4`), heldThingValue(presRef)));
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validate(v, matchVatstoreGet(rcKey(presRef), '3'));
  validateDone(v);

  rp = await dispatchMessage('finishClearHolders');
  validate(v, matchVatstoreGet(stateKey(holder2), heldThingValue(presRef)));
  validate(v, matchVatstoreGet(rcKey(presRef), '3'));
  validate(v, matchVatstoreSet(rcKey(presRef), '2'));
  validate(v, matchVatstoreSet(stateKey(holder2), heldThingValue(null)));
  validate(v, matchVatstoreGet(stateKey(holder3), heldThingValue(presRef)));
  validate(v, matchVatstoreGet(rcKey(presRef), '2'));
  validate(v, matchVatstoreSet(rcKey(presRef), '1'));
  validate(v, matchVatstoreSet(stateKey(holder3), heldThingValue(null)));
  validate(v, matchVatstoreGet(stateKey(`${holderBaseRef}/4`), heldThingValue(presRef)));
  validate(v, matchVatstoreGet(rcKey(presRef), '1'));
  validate(v, matchVatstoreSet(rcKey(presRef), '0'));
  validate(v, matchVatstoreDelete(rcKey(presRef)));
  validate(v, matchVatstoreSet(stateKey(`${holderBaseRef}/4`), heldThingValue(null)));
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validate(v, matchVatstoreGet(rcKey(presRef)));
  validateWeakCheck(v, presRef);
  validate(v, matchDropImports(presRef));
  validate(v, matchRetireImports(presRef));
  validateDone(v);
});

// prettier-ignore
test.serial('presence refcount management 2', async t => {
  const { v, dispatchMessage } = await setupTestLiveslots(t, buildRootObject, 'bob', true);

  const presRef = 'o-5';
  const [targ, tslot] = thingArg(presRef);
  let rp = await dispatchMessage('importAndHold', [targ], [tslot]);
  validateSetup(v);
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validateFauxCacheDisplacerDeletion(v);
  validateDone(v);

  rp = await dispatchMessage('prepareStore3');
  validate(v, matchVatstoreGet(rcKey(presRef)));
  validate(v, matchVatstoreSet(rcKey(presRef), '1'));
  validate(v, matchVatstoreGet(rcKey(presRef), '1'));
  validate(v, matchVatstoreSet(rcKey(presRef), '2'));
  const holder2 = `${holderBaseRef}/2`;
  validate(v, matchVatstoreSet(stateKey(holder2), heldThingValue(presRef)));
  validate(v, matchVatstoreGet(rcKey(presRef), '2'));
  validate(v, matchVatstoreSet(rcKey(presRef), '3'));
  const holder3 = `${holderBaseRef}/3`;
  validate(v, matchVatstoreSet(stateKey(holder3), heldThingValue(presRef)));
  const holder4 = `${holderBaseRef}/4`;
  validate(v, matchVatstoreSet(stateKey(holder4), heldThingValue(presRef)));
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validate(v, matchVatstoreGet(rcKey(presRef), '3'));
  validateDone(v);

  rp = await dispatchMessage('finishDropHolders');
  validateReturned(v, rp);
  validateStatusCheck(v, holder2, NONE, NONE, heldThingValue(presRef));
  validate(v, matchVatstoreGet(rcKey(presRef), '3'));
  validate(v, matchVatstoreSet(rcKey(presRef), '2'));
  validateDelete(v, holder2);
  validateWeakCheck(v, holder2);
  validateStatusCheck(v, holder3, NONE, NONE, heldThingValue(presRef));
  validate(v, matchVatstoreGet(rcKey(presRef), '2'));
  validate(v, matchVatstoreSet(rcKey(presRef), '1'));
  validateDelete(v, holder3);
  validateWeakCheck(v, holder3);
  validateStatusCheck(v, holder4, NONE, NONE, heldThingValue(presRef));
  validate(v, matchVatstoreGet(rcKey(presRef), '1'));
  validate(v, matchVatstoreSet(rcKey(presRef), '0'));
  validate(v, matchVatstoreDelete(rcKey(presRef)));
  validateDelete(v, holder4);
  validateWeakCheck(v, holder4);
  validate(v, matchVatstoreGet(rcKey(presRef)));
  validateWeakCheck(v, presRef);
  validate(v, matchDropImports(presRef));
  validate(v, matchRetireImports(presRef));
  validateDone(v);
});

// prettier-ignore
test.serial('remotable refcount management 1', async t => {
  const { v, dispatchMessage } = await setupTestLiveslots(t, buildRootObject, 'bob', true);

  let rp = await dispatchMessage('makeAndHoldRemotable');
  validateSetup(v);
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validateFauxCacheDisplacerDeletion(v);
  validateDone(v);

  rp = await dispatchMessage('prepareStore3');
  const holder2 = `${holderBaseRef}/2`;
  validate(v, matchVatstoreSet(stateKey(holder2), heldThingValue(remotableID)));
  const holder3 = `${holderBaseRef}/3`;
  validate(v, matchVatstoreSet(stateKey(holder3), heldThingValue(remotableID)));
  const holder4 = `${holderBaseRef}/4`;
  validate(v, matchVatstoreSet(stateKey(holder4), heldThingValue(remotableID)));
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validate(v, matchVatstoreSet('idCounters'));
  validateDone(v);

  rp = await dispatchMessage('finishClearHolders');
  validate(v, matchVatstoreGet(stateKey(holder2), heldThingValue(remotableID)));
  validate(v, matchVatstoreSet(stateKey(holder2), heldThingValue(null)));
  validate(v, matchVatstoreGet(stateKey(holder3), heldThingValue(remotableID)));
  validate(v, matchVatstoreSet(stateKey(holder3), heldThingValue(null)));
  validate(v, matchVatstoreGet(stateKey(holder4), heldThingValue(remotableID)));
  validate(v, matchVatstoreSet(stateKey(holder4), heldThingValue(null)));
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validateDone(v);
});

// prettier-ignore
test.serial('remotable refcount management 2', async t => {
  const { v, dispatchMessage } = await setupTestLiveslots(t, buildRootObject, 'bob', true);

  let rp = await dispatchMessage('makeAndHoldRemotable');
  validateSetup(v);
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validateFauxCacheDisplacerDeletion(v);
  validateDone(v);

  rp = await dispatchMessage('prepareStore3');
  const holder2 = `${holderBaseRef}/2`;
  validate(v, matchVatstoreSet(stateKey(holder2), heldThingValue(remotableID)));
  const holder3 = `${holderBaseRef}/3`;
  validate(v, matchVatstoreSet(stateKey(holder3), heldThingValue(remotableID)));
  const holder4 = `${holderBaseRef}/4`;
  validate(v, matchVatstoreSet(stateKey(holder4), heldThingValue(remotableID)));
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validate(v, matchVatstoreSet('idCounters'));
  validateDone(v);

  rp = await dispatchMessage('finishDropHolders');
  validateReturned(v, rp);
  validateStatusCheck(v, holder2, NONE, NONE, heldThingValue(remotableID));
  validateDelete(v, holder2);
  validateWeakCheck(v, holder2);
  validateStatusCheck(v, holder3, NONE, NONE, heldThingValue(remotableID));
  validateDelete(v, holder3);
  validateWeakCheck(v, holder3);
  validateStatusCheck(v, holder4, NONE, NONE, heldThingValue(remotableID));
  validateDelete(v, holder4);
  validateWeakCheck(v, holder4);
  validateDone(v);
});

// prettier-ignore
async function voWeakKeyGCTest(t, isf) {
  const { v, dispatchMessage, testHooks } = await setupTestLiveslots(t, buildRootObject, 'bob', true);
  const thing = thingVref(isf, 2);
  const thingf = facetRef(isf, thing, '1');

  // Create VO and hold onto it weakly
  let rp = await dispatchMessage('makeAndHoldAndKey', [isf]);
  validateSetupAndCreate(v, rp, thing);
  t.is(testHooks.countCollectionsForWeakKey(facetRef(isf, thing, '1')), 2);
  t.is(testHooks.countWeakKeysForCollection(aWeakMap), 1);
  t.is(testHooks.countWeakKeysForCollection(aWeakSet), 1);

  // Drop in-memory reference, GC should cause weak entries to disappear
  rp = await dispatchMessage('dropHeld');
  validateCheckNoWeakKeys(v, thingf);
  validateDropHeldWithGC(v, rp, thingf, NONE);
  t.is(testHooks.countCollectionsForWeakKey(facetRef(isf, thing, '1')), 0);
  t.is(testHooks.countWeakKeysForCollection(aWeakMap), 0);
  t.is(testHooks.countWeakKeysForCollection(aWeakSet), 0);
}
test.serial('verify VO weak key GC unfaceted', async t => {
  await voWeakKeyGCTest(t, false);
});
test.serial('verify VO weak key GC faceted', async t => {
  await voWeakKeyGCTest(t, true);
});

// prettier-ignore
test.serial('verify presence weak key GC', async t => {
  const { v, dispatchMessage, dispatchRetireImports, testHooks } =
        await setupTestLiveslots(t, buildRootObject, 'bob', true);

  const [targ, tslot] = thingArg('o-5');
  let rp = await dispatchMessage('importAndHoldAndKey', [targ], [tslot]);
  validateSetup(v);
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validateFauxCacheDisplacerDeletion(v);
  validateDone(v);
  t.is(testHooks.countCollectionsForWeakKey('o-5'), 2);
  t.is(testHooks.countWeakKeysForCollection(aWeakMap), 1);
  t.is(testHooks.countWeakKeysForCollection(aWeakSet), 1);

  rp = await dispatchMessage('dropHeld');
  validateWeakCheck(v, 'o-5');
  validateReturned(v, rp);
  validate(v, matchVatstoreGet(rcKey('o-5')));
  validate(v, matchDropImports('o-5'));
  validateDone(v);
  t.is(testHooks.countCollectionsForWeakKey('o-5'), 2);
  t.is(testHooks.countWeakKeysForCollection(aWeakMap), 1);
  t.is(testHooks.countWeakKeysForCollection(aWeakSet), 1);

  await dispatchRetireImports('o-5');
  validateWeakCheck(v, 'o-5'); // XXX this is weird: why two?
  validateWeakCheck(v, 'o-5');
  validateDone(v);
  t.is(testHooks.countCollectionsForWeakKey('o-5'), 0);
  t.is(testHooks.countWeakKeysForCollection(aWeakMap), 0);
  t.is(testHooks.countWeakKeysForCollection(aWeakSet), 0);
});

// To test handling of a local, non-virtual remotable *from* a virtual object,
// we have essentially the same model as used above.  However, the model
// presented is concerned with references *to* virtual objects, whose
// reachability the VOM has to manage essentially on its own, and it is the
// correctness of that management machinery that these tests have been
// constructed to validate.  However, if a non-virtual object never interacts
// with any virtual object, the VOM is not involved; what we need to be
// concerned about is the subset of states in which a virtual object refers to a
// non-virtual object (or acquires or loses such a reference), which none of the
// above tests exercise.  In the following, the letters in the LERV notation
// designate references to a non-VO.

// prettier-ignore
test.serial('VO holding non-VO', async t => {
  const { v, dispatchMessage, dispatchDropExports, dispatchRetireExports } =
        await setupTestLiveslots(t, buildRootObject, 'bob', true);

  // lerv -> Lerv  Create non-VO
  let rp = await dispatchMessage('makeAndHoldRemotable');
  validateSetup(v);
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validateFauxCacheDisplacerDeletion(v);
  validateDone(v);

  // Lerv -> LERv  Export non-VO
  rp = await dispatchMessage('exportHeld');
  validate(v, matchResolveOne(rp, thingSer(remotableID)));
  validate(v, matchVatstoreSet('idCounters'));
  validateDone(v);

  // LERv -> LERV  Store non-VO reference virtually
  rp = await dispatchMessage('storeHeld');
  validate(v, matchVatstoreGet(stateKey(virtualHolderVref), heldThingValue(null)));
  validate(v, matchVatstoreSet(stateKey(virtualHolderVref), heldThingValue(remotableID)));
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validateDone(v);

  // LERV -> LeRV  Drop the export
  await dispatchDropExports(remotableID);
  validateDone(v);

  // LeRV -> LerV  Retire the export
  await dispatchRetireExports(remotableID);
  validateDone(v);

  // LerV -> LerV  Read non-VO reference from VO and expect it to deserialize successfully
  rp = await dispatchMessage('fetchAndHold');
  validate(v, matchVatstoreGet(stateKey(virtualHolderVref), heldThingValue(remotableID)));
  validate(v, matchVatstoreGet(stateKey(cacheDisplacerVref), cacheObjValue));
  validateReturned(v, rp);
  validateDone(v);
});