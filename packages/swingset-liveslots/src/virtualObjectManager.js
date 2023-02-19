/* eslint-disable no-use-before-define, jsdoc/require-returns-type */

import { assert, Fail } from '@agoric/assert';
import { objectMap } from '@agoric/internal';
import { assertPattern, decompress, mustCompress } from '@agoric/store';
import { defendPrototype, defendPrototypeKit } from '@agoric/store/tools.js';
import { Far, hasOwnPropertyOf, passStyleOf } from '@endo/marshal';
import { parseVatSlot, makeBaseRef } from './parseVatSlots.js';
import { enumerateKeysWithPrefix } from './vatstore-iterators.js';

/** @template T @typedef {import('@agoric/vat-data').DefineKindOptions<T>} DefineKindOptions */

const { ownKeys } = Reflect;
const { details: X, quote: q } = assert;

// import { kdebug } from './kdebug.js';

// Marker associated to flag objects that should be held onto strongly if
// somebody attempts to use them as keys in a VirtualObjectAwareWeakSet or
// VirtualObjectAwareWeakMap, despite the fact that keys in such collections are
// nominally held onto weakly.  This to thwart attempts to observe GC by
// squirreling away a piece of a VO while the rest of the VO gets GC'd and then
// later regenerated.
const unweakable = new WeakSet();

/**
 * Make a simple LRU cache of virtual object inner selves.
 *
 * @param {number} size  Maximum number of entries to keep in the cache before
 *    starting to throw them away.
 * @param {(baseRef: string) => object} fetch  Function to retrieve an
 *    object's raw state from the store by its baseRef
 * @param {(baseRef: string, rawState: object) => void} store  Function to
 *   store raw object state by its baseRef
 *
 * @returns {object} An LRU cache of (up to) the given size
 *
 * This cache is part of the virtual object manager and is not intended to be
 * used independently; it is exported only for the benefit of test code.
 */
export function makeCache(size, fetch, store) {
  let lruHead;
  let lruTail;
  let dirtyCount = 0;
  const liveTable = new Map();

  const cache = {
    makeRoom() {
      while (liveTable.size > size && lruTail) {
        // kdebug(`### vo LRU evict ${lruTail.baseRef} (dirty=${lruTail.dirty})`);
        liveTable.delete(lruTail.baseRef);
        if (lruTail.dirty) {
          store(lruTail.baseRef, lruTail.rawState);
          lruTail.dirty = false;
          dirtyCount -= 1;
        }
        lruTail.rawState = null;
        if (lruTail.prev) {
          lruTail.prev.next = undefined;
        } else {
          lruHead = undefined;
        }
        const deadEntry = lruTail;
        lruTail = lruTail.prev;
        deadEntry.next = undefined;
        deadEntry.prev = undefined;
      }
    },
    markDirty(entry) {
      if (!entry.dirty) {
        entry.dirty = true;
        dirtyCount += 1;
      }
    },
    setSize(newSize) {
      if (newSize < size) {
        size = newSize;
        cache.makeRoom();
      } else {
        size = newSize;
      }
    },
    flush() {
      if (dirtyCount > 0) {
        let entry = lruTail;
        while (entry) {
          if (entry.dirty) {
            store(entry.baseRef, entry.rawState);
            entry.dirty = false;
          }
          entry = entry.prev;
        }
        dirtyCount = 0;
      }
    },
    remember(innerObj) {
      if (liveTable.has(innerObj.baseRef)) {
        return;
      }
      cache.makeRoom();
      liveTable.set(innerObj.baseRef, innerObj);
      innerObj.prev = undefined;
      innerObj.next = lruHead;
      if (lruHead) {
        lruHead.prev = innerObj;
      }
      lruHead = innerObj;
      if (!lruTail) {
        lruTail = innerObj;
      }
      // kdebug(`### vo LRU remember ${lruHead.baseRef}`);
    },
    refresh(innerObj) {
      if (innerObj !== lruHead) {
        const oldPrev = innerObj.prev;
        const oldNext = innerObj.next;
        if (oldPrev) {
          oldPrev.next = oldNext;
        } else {
          lruHead = oldNext;
        }
        if (oldNext) {
          oldNext.prev = oldPrev;
        } else {
          lruTail = oldPrev;
        }
        innerObj.prev = undefined;
        innerObj.next = lruHead;
        lruHead.prev = innerObj;
        lruHead = innerObj;
        // kdebug(`### vo LRU refresh ${lruHead.baseRef}`);
      }
    },
    lookup(baseRef, load) {
      let innerObj = liveTable.get(baseRef);
      if (innerObj) {
        cache.refresh(innerObj);
      } else {
        innerObj = { baseRef, rawState: null, repCount: 0 };
        cache.remember(innerObj);
      }
      if (load && !innerObj.rawState) {
        innerObj.rawState = fetch(baseRef);
      }
      return innerObj;
    },
  };
  return cache;
}

/**
 * Create a new virtual object manager.  There is one of these for each vat.
 *
 * @param {*} syscall
 * Vat's syscall object, used to access the vatstore operations.
 * @param {*} vrm
 * Virtual reference manager, to handle reference counting and GC
 * of virtual references.
 * @param {() => number} allocateExportID
 * Function to allocate the next object export ID for the enclosing vat.
 * @param {(val: object) => string} _getSlotForVal
 * A function that returns the object ID (vref) for a given object, if any.
 * their corresponding export IDs
 * @param {*} registerValue
 * Function to register a new slot+value in liveSlot's various tables
 * @param {import('@endo/marshal').Serialize<unknown>} serialize
 * Serializer for this vat
 * @param {import('@endo/marshal').Unserialize<unknown>} unserialize
 * Unserializer for this vat
 * @param {number} cacheSize
 * How many virtual objects this manager should cache in memory.
 * @param {*} assertAcceptableSyscallCapdataSize
 * Function to check for oversized syscall params
 *
 * @returns {object} a new virtual object manager.
 *
 * The virtual object manager allows the creation of persistent objects that do
 * not need to occupy memory when they are not in use.  It provides five
 * functions:
 *
 * - `defineKind`, `defineKindMulti`, `defineDurableKind`, and
 *    `defineDurableKindMulti` enable users to define new types of virtual
 *    object by providing an implementation of the new kind of object's
 *    behavior.  The result is a maker function that will produce new
 *    virtualized instances of the defined object type on demand.
 *
 * - `VirtualObjectAwareWeakMap` and `VirtualObjectAwareWeakSet` are drop-in
 *    replacements for JavaScript's builtin `WeakMap` and `WeakSet` classes
 *    which understand the magic internal voodoo used to implement virtual
 *    objects and will do the right thing when virtual objects are used as keys.
 *    The intent is that the hosting environment will inject these as
 *    substitutes for their regular JS analogs in way that should be transparent
 *    to ordinary users of those classes.
 *
 * - `flushCache` will empty the object manager's cache of in-memory object
 *    instances, writing any changed state to the persistent store.  This is
 *    provided for testing and to ensure that state that should be persisted
 *    actually is prior to a controlled shutdown; normal code should not use
 *    this.
 *
 * The `defineKind` functions are made available to user vat code in the
 * `VatData` global (along with various other storage functions defined
 * elsewhere).
 */
export function makeVirtualObjectManager(
  syscall,
  vrm,
  allocateExportID,
  _getSlotForVal,
  registerValue,
  serialize,
  unserialize,
  cacheSize,
  assertAcceptableSyscallCapdataSize,
) {
  const canBeDurable = specimen => {
    const capData = serialize(specimen);
    return capData.slots.every(vrm.isDurable);
  };

  const cache = makeCache(cacheSize, fetch, store);

  // WeakMap tieing VO components together, to prevent anyone who retains one
  // piece (say, the state object) from being able to observe the comings and
  // goings of representatives by hanging onto that piece while the other pieces
  // are GC'd, then comparing it to what gets generated when the VO is
  // reconstructed by a later import.
  const linkToCohort = new WeakMap();

  /**
   * Fetch an object's state from secondary storage.
   *
   * @param {string} baseRef The baseRef of the object whose state is being
   *    fetched.
   * @returns {*} an object representing the object's stored state.
   */
  function fetch(baseRef) {
    const rawState = syscall.vatstoreGet(`vom.${baseRef}`);
    if (rawState) {
      return JSON.parse(rawState);
    } else {
      return undefined;
    }
  }

  /**
   * Write an object's state to secondary storage.
   *
   * @param {string} baseRef The baseRef of the object whose state is being
   *    stored.
   * @param {*} rawState  A data object representing the state to be written.
   */
  function store(baseRef, rawState) {
    syscall.vatstoreSet(`vom.${baseRef}`, JSON.stringify(rawState));
  }

  // This is a WeakMap from VO aware weak collections to strong Sets that retain
  // keys used in the associated collection that should not actually be held
  // weakly.
  const unweakableKeySets = new WeakMap();

  function preserveUnweakableKey(collection, key) {
    if (unweakable.has(key)) {
      let uwkeys = unweakableKeySets.get(collection);
      if (!uwkeys) {
        uwkeys = new Set();
        unweakableKeySets.set(collection, uwkeys);
      }
      uwkeys.add(key);
    }
  }

  function releaseUnweakableKey(collection, key) {
    if (unweakable.has(key)) {
      const uwkeys = unweakableKeySets.get(collection);
      if (uwkeys) {
        uwkeys.delete(key);
      }
    }
  }

  /* eslint max-classes-per-file: ["error", 2] */

  const actualWeakMaps = new WeakMap();
  const virtualObjectMaps = new WeakMap();

  function voAwareWeakMapDeleter(descriptor) {
    for (const vref of descriptor.vmap.keys()) {
      vrm.removeRecognizableVref(vref, descriptor.vmap);
    }
  }

  class VirtualObjectAwareWeakMap {
    constructor() {
      actualWeakMaps.set(this, new WeakMap());
      const vmap = new Map();
      virtualObjectMaps.set(this, vmap);
      vrm.droppedCollectionRegistry.register(this, {
        collectionDeleter: voAwareWeakMapDeleter,
        vmap,
      });
    }

    has(key) {
      const vkey = vrm.vrefKey(key);
      if (vkey) {
        return virtualObjectMaps.get(this).has(vkey);
      } else {
        return actualWeakMaps.get(this).has(key);
      }
    }

    get(key) {
      const vkey = vrm.vrefKey(key);
      if (vkey) {
        return virtualObjectMaps.get(this).get(vkey);
      } else {
        return actualWeakMaps.get(this).get(key);
      }
    }

    set(key, value) {
      const vkey = vrm.vrefKey(key);
      if (vkey) {
        const vmap = virtualObjectMaps.get(this);
        if (!vmap.has(vkey)) {
          vrm.addRecognizableValue(key, vmap);
        }
        vmap.set(vkey, value);
      } else {
        preserveUnweakableKey(this, key);
        actualWeakMaps.get(this).set(key, value);
      }
      return this;
    }

    delete(key) {
      const vkey = vrm.vrefKey(key);
      if (vkey) {
        const vmap = virtualObjectMaps.get(this);
        if (vmap.has(vkey)) {
          vrm.removeRecognizableValue(key, vmap);
          return vmap.delete(vkey);
        } else {
          return false;
        }
      } else {
        releaseUnweakableKey(this, key);
        return actualWeakMaps.get(this).delete(key);
      }
    }
  }

  Object.defineProperty(VirtualObjectAwareWeakMap, Symbol.toStringTag, {
    value: 'WeakMap',
    writable: false,
    enumerable: false,
    configurable: true,
  });

  const actualWeakSets = new WeakMap();
  const virtualObjectSets = new WeakMap();

  function voAwareWeakSetDeleter(descriptor) {
    for (const vref of descriptor.vset.values()) {
      vrm.removeRecognizableVref(vref, descriptor.vset);
    }
  }

  class VirtualObjectAwareWeakSet {
    constructor() {
      actualWeakSets.set(this, new WeakSet());
      const vset = new Set();
      virtualObjectSets.set(this, vset);

      vrm.droppedCollectionRegistry.register(this, {
        collectionDeleter: voAwareWeakSetDeleter,
        vset,
      });
    }

    has(value) {
      const vkey = vrm.vrefKey(value);
      if (vkey) {
        return virtualObjectSets.get(this).has(vkey);
      } else {
        return actualWeakSets.get(this).has(value);
      }
    }

    add(value) {
      const vkey = vrm.vrefKey(value);
      if (vkey) {
        const vset = virtualObjectSets.get(this);
        if (!vset.has(value)) {
          vrm.addRecognizableValue(value, vset);
          vset.add(vkey);
        }
      } else {
        preserveUnweakableKey(this, value);
        actualWeakSets.get(this).add(value);
      }
      return this;
    }

    delete(value) {
      const vkey = vrm.vrefKey(value);
      if (vkey) {
        const vset = virtualObjectSets.get(this);
        if (vset.has(vkey)) {
          vrm.removeRecognizableValue(value, vset);
          return vset.delete(vkey);
        } else {
          return false;
        }
      } else {
        releaseUnweakableKey(this, value);
        return actualWeakSets.get(this).delete(value);
      }
    }
  }

  Object.defineProperty(VirtualObjectAwareWeakSet, Symbol.toStringTag, {
    value: 'WeakSet',
    writable: false,
    enumerable: false,
    configurable: true,
  });

  /**
   * Assess the facetiousness of a value.  If the value is an object containing
   * only named properties and each such property's value is a function, `obj`
   * represents a single facet and 'one' is returned.  If each property's value
   * is instead an object of facetiousness 'one', `obj` represents multiple
   * facets and 'many' is returned.  In all other cases `obj` does not represent
   * any kind of facet abstraction and 'not' is returned.
   *
   * @typedef {'one'|'many'|'not'} Facetiousness
   *
   * @param {*} obj  The (alleged) object to be assessed
   * @param {boolean} [inner]  True if this is being called recursively; no more
   *    than one level of recursion is allowed.
   *
   * @returns {Facetiousness} an assessment of the facetiousness of `obj`
   */
  function assessFacetiousness(obj, inner) {
    if (typeof obj !== 'object') {
      return 'not';
    }
    let established;
    for (const prop of Reflect.ownKeys(obj)) {
      const value = obj[prop];
      let current;
      if (typeof value === 'function') {
        current = 'one';
      } else if (
        !inner &&
        typeof value === 'object' &&
        assessFacetiousness(value, true) === 'one'
      ) {
        if (typeof prop === 'symbol') {
          // can't have symbol-named facets
          return 'not';
        }
        current = 'many';
      } else {
        return 'not';
      }
      if (!established) {
        established = current;
      } else if (established !== current) {
        return 'not';
      }
    }
    if (!established) {
      // empty objects are methodless Far objects
      return 'one';
    } else {
      return /** @type {Facetiousness} */ (established);
    }
  }

  /**
   * @typedef {{
   *  kindID: string,
   *  nextInstanceID: number,
   *  tag: string,
   *  unfaceted?: boolean,
   *  facets?: string[],
   * }} DurableKindDescriptor
   */

  /**
   * Define a new kind of virtual object.
   *
   * @param {string} kindID  The kind ID to associate with the new kind.
   *
   * @param {string} tag  A descriptive tag string as used in calls to `Far`
   *
   * @param {*} init  An initialization function that will return the initial
   *    state of a new instance of the kind of virtual object being defined.
   *
   * @param {boolean} multifaceted True if this should be a multi-faceted
   *    virtual object, false if it should be single-faceted.
   *
   * @param {*} behavior A bag of functions (in the case of a single-faceted
   *    object) or a bag of bags of functions (in the case of a multi-faceted
   *    object) that will become the methods of the object or its facets.
   *
   * @param {DefineKindOptions<*>} options
   *    Additional options to configure the virtual object kind
   *    being defined. See the documentation of DefineKindOptions
   *    for the meaning of each option.
   *
   * @param {boolean} isDurable  A flag indicating whether or not the newly defined
   *    kind should be a durable kind.
   *
   * @param {DurableKindDescriptor} [durableKindDescriptor]  Descriptor for the
   *    durable kind, if it is, in fact, durable
   *
   * @returns {*} a maker function that can be called to manufacture new
   *    instances of this kind of object.  The parameters of the maker function
   *    are those of the `init` function.
   *
   * Notes on theory of operation:
   *
   * Virtual objects are structured in three layers: representatives, inner
   * selves, and state data.
   *
   * A representative is the manifestation of a virtual object that vat code has
   * direct access to.  A given virtual object can have at most one
   * representative, which will be created as needed.  This will happen when the
   * instance is initially made, and can also happen (if it does not already
   * exist) when the instance's virtual object ID is deserialized, either when
   * delivered as part of an incoming message or read as part of another virtual
   * object's state.  A representative will be kept alive in memory as long as
   * there is a variable somewhere that references it directly or indirectly.
   * However, if a representative becomes unreferenced in memory it is subject
   * to garbage collection, leaving the representation that is kept in the vat
   * store as the record of its state from which a mew representative can be
   * reconstituted at need.  Since only one representative exists at a time,
   * references to them may be compared with the equality operator (===).
   * Although the identity of a representative can change over time, this is
   * never visible to code running in the vat.  Methods invoked on a
   * representative always operate on the underlying virtual object state.
   *
   * The inner self represents the in-memory information about an object, aside
   * from its state.  There is an inner self for each virtual object that is
   * currently resident in memory; that is, there is an inner self for each
   * virtual object for which there is currently a representative present
   * somewhere in the vat.  The inner self maintains two pieces of information:
   * its corresponding virtual object's virtual object ID, and a pointer to the
   * virtual object's state in memory if the virtual object's state is, in fact,
   * currently resident in memory.  If the state is not in memory, the inner
   * self's pointer to the state is null.  In addition, the virtual object
   * manager maintains an LRU cache of inner selves.  Inner selves that are in
   * the cache are not necessarily referenced by any existing representative,
   * but are available to be used should such a representative be needed.  How
   * this all works will be explained in a moment.
   *
   * The state of a virtual object is a collection of mutable properties, each
   * of whose values is itself immutable and serializable.  The methods of a
   * virtual object have access to this state by closing over a state object.
   * However, the state object they close over is not the actual state object,
   * but a wrapper with accessor methods that both ensure that a representation
   * of the state is in memory when needed and perform deserialization on read
   * and serialization on write; this wrapper is held by the representative, so
   * that method invocations always see the wrapper belonging to the invoking
   * representative.  The actual state object holds marshaled serializations of
   * each of the state properties.  When written to persistent storage, this is
   * represented as a JSON-stringified object each of whose properties is one
   * of the marshaled property values.
   *
   * When a method of a virtual object attempts to access one of the properties
   * of the object's state, the accessor first checks to see if the state is in
   * memory.  If it is not, it is loaded from persistent storage, the
   * corresponding inner self is made to point at it, and then the inner self is
   * placed at the head of the LRU cache (causing the least recently used inner
   * self to fall off the end of the cache).  If it *is* in memory, it is
   * promoted to the head of the LRU cache but the overall contents of the cache
   * remain unchanged.  When an inner self falls off the end of the LRU, its
   * reference to the state is nulled out and the object holding the state
   * becomes garbage collectable.
   */
  function defineKindInternal(
    kindID,
    tag,
    init,
    multifaceted,
    behavior,
    options = {},
    isDurable,
    durableKindDescriptor,
  ) {
    const {
      finish,
      stateShape = undefined,
      thisfulMethods = false,
      interfaceGuard = undefined,
    } = options;
    let facetNames;
    let contextMapTemplate;
    let prototypeTemplate;

    harden(stateShape);
    stateShape === undefined ||
      passStyleOf(stateShape) === 'copyRecord' ||
      assert.fail(X`A stateShape must be a copyRecord: ${q(stateShape)}`);
    assertPattern(stateShape);

    const serializeSlot = (slotState, prop) => {
      if (stateShape === undefined) {
        return serialize(slotState);
      }
      hasOwnPropertyOf(stateShape, prop) ||
        assert.fail(
          X`State must only have fields described by stateShape: ${q(
            ownKeys(stateShape),
          )}`,
        );
      return serialize(mustCompress(slotState, stateShape[prop], prop));
    };

    const unserializeSlot = (slotData, prop) => {
      if (stateShape === undefined) {
        return unserialize(slotData);
      }
      hasOwnPropertyOf(stateShape, prop) ||
        assert.fail(
          X`State only has fields described by stateShape: ${q(
            ownKeys(stateShape),
          )}`,
        );
      return decompress(unserialize(slotData), stateShape[prop]);
    };

    const facetiousness = assessFacetiousness(behavior);
    switch (facetiousness) {
      case 'one': {
        assert(!multifaceted);
        facetNames = undefined;
        contextMapTemplate = new WeakMap();
        prototypeTemplate = defendPrototype(
          tag,
          contextMapTemplate,
          behavior,
          thisfulMethods,
          interfaceGuard,
        );
        break;
      }
      case 'many': {
        assert(multifaceted);
        facetNames = Object.getOwnPropertyNames(behavior).sort();
        contextMapTemplate = objectMap(behavior, () => new WeakMap());
        prototypeTemplate = defendPrototypeKit(
          tag,
          contextMapTemplate,
          behavior,
          thisfulMethods,
          interfaceGuard,
        );
        break;
      }
      case 'not': {
        throw Fail`invalid behavior specifier for ${q(tag)}`;
      }
      default: {
        throw Fail`unexepected facetiousness: ${q(facetiousness)}`;
      }
    }

    if (durableKindDescriptor) {
      const { unfaceted, facets } = durableKindDescriptor;
      if (multifaceted) {
        assert(
          !unfaceted,
          `durable kind "${tag}" originally defined as single-faceted`,
        );
        if (facets) {
          const m = `durable kind "${tag}" facets don't match original definition`;
          assert(
            facetNames !== undefined && facets.length === facetNames.length,
            m,
          );
          for (const [idx, facet] of facetNames.entries()) {
            assert(facet === facets[idx], m);
          }
        } else {
          durableKindDescriptor.facets = facetNames;
          saveDurableKindDescriptor(durableKindDescriptor);
        }
      } else {
        assert(
          !facets,
          `durable kind "${tag}" originally defined as multi-faceted`,
        );
        if (!unfaceted) {
          durableKindDescriptor.unfaceted = true;
          saveDurableKindDescriptor(durableKindDescriptor);
        }
      }
    }

    vrm.registerKind(kindID, reanimate, deleteStoredVO, isDurable);
    vrm.rememberFacetNames(kindID, facetNames);
    harden(contextMapTemplate);
    harden(prototypeTemplate);

    function makeRepresentative(innerSelf, initializing) {
      innerSelf.repCount === 0 ||
        Fail`${innerSelf.baseRef} already has a representative`;
      innerSelf.repCount += 1;

      function ensureState() {
        if (innerSelf.rawState) {
          cache.refresh(innerSelf);
        } else {
          innerSelf = cache.lookup(innerSelf.baseRef, true);
        }
      }

      const state = {};
      if (!initializing) {
        ensureState();
      }
      for (const prop of Object.getOwnPropertyNames(innerSelf.rawState)) {
        Object.defineProperty(state, prop, {
          get: () => {
            ensureState();
            return unserializeSlot(innerSelf.rawState[prop], prop);
          },
          set: value => {
            ensureState();
            const before = innerSelf.rawState[prop];
            const after = serializeSlot(value, prop);
            assertAcceptableSyscallCapdataSize([after]);
            if (isDurable) {
              after.slots.forEach((vref, index) => {
                vrm.isDurable(vref) ||
                  Fail`value for ${q(prop)} is not durable at slot ${q(
                    index,
                  )} of ${after}`;
              });
            }
            vrm.updateReferenceCounts(before.slots, after.slots);
            innerSelf.rawState[prop] = after;
            cache.markDirty(innerSelf);
          },
          enumerable: true,
        });
      }
      harden(state);

      if (initializing) {
        cache.remember(innerSelf);
      }
      let toHold;
      let toExpose;
      unweakable.add(state);
      if (!facetNames) {
        const context = { state };
        // `context` does not need a linkToCohort because it holds the
        // facets (which hold the cohort)
        unweakable.add(context);
        const self = harden({ __proto__: prototypeTemplate });
        context.self = self;
        contextMapTemplate.set(self, context);
        toHold = self;
        toExpose = toHold;
        harden(context);
      } else {
        toExpose = {};
        toHold = [];
        const facets = {};
        const context = { state, facets };
        for (const name of facetNames) {
          const facet = harden({
            __proto__: prototypeTemplate[name],
          });
          contextMapTemplate[name].set(facet, context);
          facets[name] = facet;
          toExpose[name] = facet;
          toHold.push(facet);
          linkToCohort.set(facet, toHold);
        }
        unweakable.add(facets);
        harden(context);
        harden(facets);
        harden(toExpose);
        harden(toHold);
      }
      innerSelf.representative = toHold;
      linkToCohort.set(state, toHold);
      return [toHold, toExpose, state];
    }

    function reanimate(baseRef) {
      // kdebug(`vo reanimate ${baseRef}`);
      const innerSelf = cache.lookup(baseRef, false);
      const [toHold] = makeRepresentative(innerSelf, false);
      return toHold;
    }

    function deleteStoredVO(baseRef) {
      let doMoreGC = false;
      const rawState = fetch(baseRef);
      if (rawState) {
        for (const propValue of Object.values(rawState)) {
          propValue.slots.forEach(vref => {
            doMoreGC = vrm.removeReachableVref(vref) || doMoreGC;
          });
        }
      }
      syscall.vatstoreDelete(`vom.${baseRef}`);
      return doMoreGC;
    }

    function makeNewInstance(...args) {
      const id = getNextInstanceID(kindID, isDurable);
      const baseRef = makeBaseRef(kindID, id, isDurable);
      // kdebug(`vo make ${baseRef}`);

      const initialData = init ? init(...args) : {};
      const rawState = {};
      for (const prop of Object.getOwnPropertyNames(initialData)) {
        const data = serializeSlot(initialData[prop], prop);
        assertAcceptableSyscallCapdataSize([data]);
        if (isDurable) {
          data.slots.forEach(vref => {
            vrm.isDurable(vref) || Fail`value for ${q(prop)} is not durable`;
          });
        }
        data.slots.forEach(vrm.addReachableVref);
        rawState[prop] = data;
      }
      const innerSelf = { baseRef, rawState, repCount: 0 };
      const [toHold, toExpose, state] = makeRepresentative(innerSelf, true);
      registerValue(baseRef, toHold, Array.isArray(toHold));
      if (finish) {
        if (toHold === toExpose) {
          finish({ state, self: toExpose });
        } else {
          finish({ state, facets: toExpose });
        }
      }
      cache.markDirty(innerSelf);
      return toExpose;
    }

    return makeNewInstance;
  }

  let kindIDID;
  const kindHandleToID = new WeakMap();
  /** @type Map<string, DurableKindDescriptor> */
  const kindIDToDescriptor = new Map();
  const definedDurableKinds = new Set(); // kindID

  function initializeKindHandleKind() {
    kindIDID = syscall.vatstoreGet('kindIDID');
    if (!kindIDID) {
      kindIDID = `${allocateExportID()}`;
      syscall.vatstoreSet('kindIDID', kindIDID);
    }
    vrm.registerKind(kindIDID, reanimateDurableKindID, () => null, true);
  }

  const nextInstanceIDs = new Map(); // kindID -> nextInstanceID

  /**
   * @param {DurableKindDescriptor} durableKindDescriptor
   */
  function saveDurableKindDescriptor(durableKindDescriptor) {
    syscall.vatstoreSet(
      `vom.dkind.${durableKindDescriptor.kindID}`,
      JSON.stringify(durableKindDescriptor),
    );
  }

  function getNextInstanceID(kindID, isDurable) {
    assert.typeof(kindID, 'string');
    // nextInstanceID is initialized to 1 for brand new kinds, loaded
    // from DB when redefining existing kinds, held in RAM, and
    // written to DB after each increment as part of
    // kindDescriptors[kindID]
    const id = nextInstanceIDs.get(kindID);
    assert(id !== undefined);
    const next = id + 1;
    nextInstanceIDs.set(kindID, next);
    if (isDurable) {
      const durableKindDescriptor = kindIDToDescriptor.get(kindID);
      assert(durableKindDescriptor);
      durableKindDescriptor.nextInstanceID = next;
      saveDurableKindDescriptor(durableKindDescriptor);
    }
    return id;
  }

  function defineKind(tag, init, behavior, options) {
    const kindID = `${allocateExportID()}`;
    syscall.vatstoreSet(`vom.vkind.${kindID}`, JSON.stringify({ kindID, tag }));
    nextInstanceIDs.set(kindID, 1);
    return defineKindInternal(
      kindID,
      tag,
      init,
      false,
      behavior,
      options,
      false,
    );
  }

  function defineKindMulti(tag, init, behavior, options) {
    const kindID = `${allocateExportID()}`;
    syscall.vatstoreSet(`vom.vkind.${kindID}`, JSON.stringify({ kindID, tag }));
    nextInstanceIDs.set(kindID, 1);
    return defineKindInternal(
      kindID,
      tag,
      init,
      true,
      behavior,
      options,
      false,
    );
  }

  function reanimateDurableKindID(vobjID) {
    const kindID = `${parseVatSlot(vobjID).subid}`;
    const raw = syscall.vatstoreGet(`vom.dkind.${kindID}`);
    raw || Fail`unknown kind ID ${kindID}`;
    const durableKindDescriptor = JSON.parse(raw);
    const kindHandle = Far('kind', {});
    linkToCohort.set(Object.getPrototypeOf(kindHandle), kindHandle);
    unweakable.add(Object.getPrototypeOf(kindHandle));
    kindHandleToID.set(kindHandle, kindID);
    // we load the descriptor (including .nextInstanceID) every time
    // the vat makes a new DurableKindHandle representative (during
    // deserialization). The handle is held weakly and can be dropped,
    // but the KindID-to-descriptor mapping remains in memory.
    kindIDToDescriptor.set(kindID, durableKindDescriptor);
    return kindHandle;
  }

  /**
   *
   * @param {string} tag
   * @returns {import('@agoric/vat-data').DurableKindHandle}
   */
  const makeKindHandle = tag => {
    assert(kindIDID, `initializeKindHandleKind not called yet`);
    const kindID = `${allocateExportID()}`;
    const kindIDvref = makeBaseRef(kindIDID, kindID, true);
    const durableKindDescriptor = { kindID, tag, nextInstanceID: 1 };
    /** @type {import('@agoric/vat-data').DurableKindHandle} */
    // eslint-disable-next-line @typescript-eslint/prefer-ts-expect-error -- https://github.com/Agoric/agoric-sdk/issues/4620
    // @ts-ignore cast
    const kindHandle = Far('kind', {});
    linkToCohort.set(Object.getPrototypeOf(kindHandle), kindHandle);
    unweakable.add(Object.getPrototypeOf(kindHandle));
    kindHandleToID.set(kindHandle, kindID);
    kindIDToDescriptor.set(kindID, durableKindDescriptor);
    registerValue(kindIDvref, kindHandle, false);
    saveDurableKindDescriptor(durableKindDescriptor);
    return kindHandle;
  };

  function defineDurableKind(kindHandle, init, behavior, options) {
    assert(kindHandleToID.has(kindHandle), `unknown handle ${kindHandle}`);
    const kindID = kindHandleToID.get(kindHandle);
    const durableKindDescriptor = kindIDToDescriptor.get(kindID);
    assert(durableKindDescriptor);
    const { tag, nextInstanceID } = durableKindDescriptor;
    assert(
      !definedDurableKinds.has(kindID),
      `redefinition of durable kind "${tag}"`,
    );
    nextInstanceIDs.set(kindID, nextInstanceID);
    const maker = defineKindInternal(
      kindID,
      tag,
      init,
      false,
      behavior,
      options,
      true,
      durableKindDescriptor,
    );
    definedDurableKinds.add(kindID);
    return maker;
  }

  function defineDurableKindMulti(kindHandle, init, behavior, options) {
    assert(kindHandleToID.has(kindHandle), `unknown handle ${kindHandle}`);
    const kindID = kindHandleToID.get(kindHandle);
    const durableKindDescriptor = kindIDToDescriptor.get(kindID);
    assert(durableKindDescriptor);
    const { tag, nextInstanceID } = durableKindDescriptor;
    assert(
      !definedDurableKinds.has(kindID),
      `redefinition of durable kind "${tag}"`,
    );
    nextInstanceIDs.set(kindID, nextInstanceID);
    const maker = defineKindInternal(
      kindID,
      tag,
      init,
      true,
      behavior,
      options,
      true,
      durableKindDescriptor,
    );
    definedDurableKinds.add(kindID);
    return maker;
  }

  function setCacheSize(newSize) {
    cache.setSize(newSize);
  }

  function insistAllDurableKindsReconnected() {
    // identify all user-defined durable kinds by iterating `vom.dkind.*`
    const missing = [];
    const prefix = 'vom.dkind.';
    for (const key of enumerateKeysWithPrefix(syscall, prefix)) {
      const value = syscall.vatstoreGet(key);
      const durableKindDescriptor = JSON.parse(value);
      if (!definedDurableKinds.has(durableKindDescriptor.kindID)) {
        missing.push(durableKindDescriptor.tag);
      }
    }
    if (missing.length) {
      const tags = missing.join(',');
      throw Error(`defineDurableKind not called for tags: [${tags}]`);
    }
  }

  function countWeakKeysForCollection(collection) {
    const virtualObjectMap = virtualObjectMaps.get(collection);
    if (virtualObjectMap) {
      return virtualObjectMap.size;
    }
    const virtualObjectSet = virtualObjectSets.get(collection);
    if (virtualObjectSet) {
      return virtualObjectSet.size;
    }
    return 0;
  }

  const testHooks = {
    countWeakKeysForCollection,
  };

  return harden({
    initializeKindHandleKind,
    defineKind,
    defineKindMulti,
    defineDurableKind,
    defineDurableKindMulti,
    makeKindHandle,
    insistAllDurableKindsReconnected,
    VirtualObjectAwareWeakMap,
    VirtualObjectAwareWeakSet,
    setCacheSize,
    flushCache: cache.flush,
    testHooks,
    canBeDurable,
  });
}
/**
 * @typedef { ReturnType<typeof makeVirtualObjectManager> } VirtualObjectManager
 */
