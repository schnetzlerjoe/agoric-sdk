import {
  makeScalarBigMapStore,
  provide,
  provideDurableSetStore,
} from '@agoric/vat-data';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';

/// <reference types="@agoric/notifier/src/types-ambient.js"/>

/**
 * @template K Key
 * @template {{}} E Ephemeral state
 * @param {() => E} init
 */
export const makeEphemeraProvider = init => {
  /** @type {Map<K, E>} */
  const ephemeras = new Map();

  /**
   * Provide an object to hold state that need not (or cannot) be durable.
   *
   * @type {(key: K) => E}
   */
  return key => {
    if (ephemeras.has(key)) {
      // @ts-expect-error cast
      return ephemeras.get(key);
    }
    const newEph = init();
    ephemeras.set(key, newEph);
    return newEph;
  };
};
harden(makeEphemeraProvider);

/**
 *
 */
export const makeTopicMetaProvider = () => {
  /** @type {WeakMap<Subscriber<any>, import('@agoric/notifier').TopicMeta<any>>} */
  const extant = new WeakMap();

  /**
   * Provide a TopicMeta for the specified durable subscriber.
   * Caches the resolution of the promise for the storageNode's path.
   *
   * @template {object} T
   * @param {string} description
   * @param {Subscriber<T>} durableSubscriber primary key
   * @param {ERef<StorageNode>} storageNode
   * @returns {import('@agoric/notifier').TopicMeta<T>}
   */
  const provideTopicMeta = (description, durableSubscriber, storageNode) => {
    if (extant.has(durableSubscriber)) {
      // @ts-expect-error cast
      return extant.get(durableSubscriber);
    }

    /** @type {import('@agoric/notifier').TopicMeta<T>} */
    const newMeta = {
      description,
      topic: durableSubscriber,
      storagePath: E(storageNode).getPath(),
    };
    extant.set(durableSubscriber, newMeta);
    return newMeta;
  };
  return provideTopicMeta;
};
harden(makeTopicMetaProvider);

/**
 * Provide an empty ZCF seat.
 *
 * @param {ZCF} zcf
 * @param {import('@agoric/ertp').Baggage} baggage
 * @param {string} name
 * @returns {ZCFSeat}
 */
export const provideEmptySeat = (zcf, baggage, name) => {
  return provide(baggage, name, () => zcf.makeEmptySeatKit().zcfSeat);
};
harden(provideEmptySeat);

/**
 * For making singletons, so that each baggage carries a separate kind definition (albeit of the definer)
 *
 * @param {import('@agoric/vat-data').Baggage} baggage
 * @param {string} category diagnostic tag
 */
export const provideChildBaggage = (baggage, category) => {
  const baggageSet = provideDurableSetStore(baggage, `${category}Set`);
  return Far('childBaggageManager', {
    // TODO(types) infer args
    /**
     * @template {(baggage: import('@agoric/ertp').Baggage, ...rest: any) => any} M Maker function
     * @param {string} childName diagnostic tag
     * @param {M} makeChild
     * @param {...any} nonBaggageArgs
     * @returns {ReturnType<M>}
     */
    addChild: (childName, makeChild, ...nonBaggageArgs) => {
      const childStore = makeScalarBigMapStore(`${childName}${category}`, {
        durable: true,
      });
      const result = makeChild(childStore, ...nonBaggageArgs);
      baggageSet.add(childStore);
      return result;
    },
    children: () => baggageSet.values(),
  });
};
harden(provideChildBaggage);
/** @typedef {ReturnType<typeof provideChildBaggage>} ChildBaggageManager */