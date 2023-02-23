import {
  M,
  makeExo,
  defineExoClass,
  defineExoClassKit,
  makeScalarMapStore,
  makeScalarSetStore,
  makeScalarWeakMapStore,
  makeScalarWeakSetStore,
} from '@agoric/store';

/**
 * @typedef {object} Zone A bag of methods for creating defensible objects and
 * collections with the same allocation semantics (ephemeral, persistent, etc)
 * @property {typeof defineExoClass} exoClass
 * @property {typeof defineExoClassKit} exoClassKit
 * @property {typeof makeExo} exoSingleton
 * @property {(specimen: unknown) => boolean} isStorable
 * @property {<K,V>(label: string, options?: StoreOptions) => MapStore<K, V>} mapStore
 * @property {<K>(label: string, options?: StoreOptions) => SetStore<K>} setStore
 * @property {<K,V>(
 *   label: string, options?: StoreOptions) => WeakMapStore<K, V>
 * } weakMapStore
 * @property {<K>(
 *   label: string, options?: StoreOptions) => WeakSetStore<K>
 * } weakSetStore
 * @property {(label: string, options?: StoreOptions) => Zone} subZone
 */

/**
 * An ephemeral (in-memory) zone that uses the default exo and store
 * implementations.
 *
 * @type {import('.').Zone}
 */
export const ephemeralZone = harden({
  exoClass: defineExoClass,
  exoClassKit: defineExoClassKit,
  exoSingleton: makeExo,

  isStorable: _specimen => true,

  setStore: makeScalarSetStore,
  mapStore: makeScalarMapStore,
  weakMapStore: makeScalarWeakMapStore,
  weakSetStore: makeScalarWeakSetStore,

  subZone: (_label, _options) => ephemeralZone,
});

export { M };
