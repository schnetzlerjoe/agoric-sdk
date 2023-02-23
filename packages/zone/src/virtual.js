import {
  defineVirtualExoClass,
  defineVirtualExoClassKit,
  makeScalarBigMapStore,
  makeScalarBigSetStore,
  makeScalarBigWeakMapStore,
  makeScalarBigWeakSetStore,
} from '@agoric/vat-data';

const initEmpty = harden(() => {});

/**
 * This implementation of `defineVirtualExo` only exists to ensure there are no
 * gaps in the virtualZone API.
 *
 * @type {import('.').Zone['exoSingleton']}
 */
const defineVirtualExo = (
  label,
  interfaceGuard,
  methods,
  options = undefined,
) => {
  const defineKindOptions =
    /** @type {import('@agoric/vat-data').DefineKindOptions<{ self: typeof methods }>} */ (
      options
    );
  const makeInstance = defineVirtualExoClass(
    label,
    interfaceGuard,
    initEmpty,
    methods,
    defineKindOptions,
  );
  return makeInstance();
};

/** @type {import('.').Zone} */
export const virtualZone = harden({
  exoSingleton: defineVirtualExo,
  exoClass: defineVirtualExoClass,
  exoClassKit: defineVirtualExoClassKit,

  isStorable: _specimen => true,
  mapStore: makeScalarBigMapStore,
  setStore: makeScalarBigSetStore,
  weakMapStore: makeScalarBigWeakMapStore,
  weakSetStore: makeScalarBigWeakSetStore,
  subZone: (_label, _options = {}) => virtualZone,
});
harden(virtualZone);
