import {
  canBeDurable,
  prepareExo,
  prepareExoClass,
  prepareExoClassKit,
  provideDurableMapStore,
  provideDurableSetStore,
  provideDurableWeakMapStore,
  provideDurableWeakSetStore,
} from '@agoric/vat-data';

/**
 * @param {import('@agoric/vat-data').Baggage} baggage
 * @returns {import('.').Zone}
 */
export const makeDurableZone = baggage => {
  /** @type {import('.').Zone['exoClass']} */
  const exoClass = (...args) => prepareExoClass(baggage, ...args);
  /** @type {import('.').Zone['exoClassKit']} */
  const exoClassKit = (...args) => prepareExoClassKit(baggage, ...args);
  /** @type {import('.').Zone['exoSingleton']} */
  const exoSingleton = (...args) => prepareExo(baggage, ...args);

  /** @type {import('.').Zone['mapStore']} */
  const mapStore = (label, options) =>
    provideDurableMapStore(baggage, label, options);
  /** @type {import('.').Zone['setStore']} */
  const setStore = (label, options) =>
    provideDurableSetStore(baggage, label, options);
  /** @type {import('.').Zone['weakSetStore']} */
  const weakSetStore = (label, options) =>
    provideDurableWeakSetStore(baggage, label, options);
  /** @type {import('.').Zone['weakMapStore']} */
  const weakMapStore = (label, options) =>
    provideDurableWeakMapStore(baggage, label, options);

  /** @type {import('.').Zone['subZone']} */
  const subZone = (label, options = {}) => {
    const subBaggage = provideDurableMapStore(baggage, label, options);
    return makeDurableZone(subBaggage);
  };

  return harden({
    exoSingleton,
    exoClass,
    exoClassKit,
    isStorable: canBeDurable,
    mapStore,
    setStore,
    weakMapStore,
    weakSetStore,
    subZone,
  });
};
harden(makeDurableZone);
