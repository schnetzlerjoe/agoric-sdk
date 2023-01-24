// @ts-check
import { E } from '@endo/eventual-send';
import { deeplyFulfilled, isObject } from '@endo/marshal';
import { isPromise } from '@endo/promise-kit';
import { asyncGenerate } from 'jessie.js';

/** @typedef {import('@endo/marshal/src/types').Remotable} Remotable */

const {
  getPrototypeOf,
  create,
  entries,
  fromEntries,
  getOwnPropertyDescriptors,
} = Object;
const { ownKeys, apply } = Reflect;

const { details: X, quote: q, Fail } = assert;

/**
 * Throws if multiple entries use the same property name. Otherwise acts
 * like `Object.fromEntries` but hardens the result.
 * Use it to protect from property names computed from user-provided data.
 *
 * @template K,V
 * @param {Iterable<[K,V]>} allEntries
 * @returns {{[k: K]: V}}
 */
export const fromUniqueEntries = allEntries => {
  const entriesArray = [...allEntries];
  const result = harden(fromEntries(entriesArray));
  if (ownKeys(result).length === entriesArray.length) {
    return result;
  }
  const names = new Set();
  for (const [name, _] of entriesArray) {
    if (names.has(name)) {
      Fail`collision on property name ${q(name)}: ${entriesArray}`;
    }
    names.add(name);
  }
  throw Fail`internal: failed to create object from unique entries`;
};
harden(fromUniqueEntries);

/**
 * By analogy with how `Array.prototype.map` will map the elements of
 * an array to transformed elements of an array of the same shape,
 * `objectMap` will do likewise for the string-named own enumerable
 * properties of an object.
 *
 * Typical usage applies `objectMap` to a CopyRecord, i.e.,
 * an object for which `passStyleOf(original) === 'copyRecord'`. For these,
 * none of the following edge cases arise. The result will be a CopyRecord
 * with exactly the same property names, whose values are the mapped form of
 * the original's values.
 *
 * When the original is not a CopyRecord, some edge cases to be aware of
 *    * No matter how mutable the original object, the returned object is
 *      hardened.
 *    * Only the string-named enumerable own properties of the original
 *      are mapped. All other properties are ignored.
 *    * If any of the original properties were accessors, `Object.entries`
 *      will cause its `getter` to be called and will use the resulting
 *      value.
 *    * No matter whether the original property was an accessor, writable,
 *      or configurable, all the properties of the returned object will be
 *      non-writable, non-configurable, data properties.
 *    * No matter what the original object may have inherited from, and
 *      no matter whether it was a special kind of object such as an array,
 *      the returned object will always be a plain object inheriting directly
 *      from `Object.prototype` and whose state is only these new mapped
 *      own properties.
 *
 * With these differences, even if the original object was not a CopyRecord,
 * if all the mapped values are Passable, then the returned object will be
 * a CopyRecord.
 *
 * @template {Record<string, any>} O
 * @param {O} original
 * @template R map result
 * @param {(value: O[keyof O], key: keyof O) => R} mapFn
 * @returns {{ [P in keyof O]: R}}
 */
export const objectMap = (original, mapFn) => {
  const ents = entries(original);
  const mapEnts = ents.map(([k, v]) => [k, mapFn(v, k)]);
  return harden(fromEntries(mapEnts));
};
harden(objectMap);

/**
 *
 * @param {Array<string | symbol>} leftNames
 * @param {Array<string | symbol>} rightNames
 */
export const listDifference = (leftNames, rightNames) => {
  const rightSet = new Set(rightNames);
  return leftNames.filter(name => !rightSet.has(name));
};
harden(listDifference);

/**
 * @param {Error} innerErr
 * @param {string|number} label
 * @param {ErrorConstructor=} ErrorConstructor
 * @returns {never}
 */
export const throwLabeled = (innerErr, label, ErrorConstructor = undefined) => {
  if (typeof label === 'number') {
    label = `[${label}]`;
  }
  const outerErr = assert.error(
    `${label}: ${innerErr.message}`,
    ErrorConstructor,
  );
  assert.note(outerErr, X`Caused by ${innerErr}`);
  throw outerErr;
};
harden(throwLabeled);

/**
 * @template A,R
 * @param {(...args: A[]) => R} func
 * @param {A[]} args
 * @param {string|number} [label]
 * @returns {R}
 */
export const applyLabelingError = (func, args, label = undefined) => {
  if (label === undefined) {
    return func(...args);
  }
  let result;
  try {
    result = func(...args);
  } catch (err) {
    throwLabeled(err, label);
  }
  if (isPromise(result)) {
    // @ts-expect-error If result is a rejected promise, this will
    // return a promise with a different rejection reason. But this
    // confuses TypeScript because it types that case as `Promise<never>`
    // which is cool for a promise that will never fulfll.
    // But TypeScript doesn't understand that this will only happen
    // when `result` was a rejected promise. In only this case `R`
    // should already allow `Promise<never>` as a subtype.
    return E.when(result, undefined, reason => throwLabeled(reason, label));
  } else {
    return result;
  }
};
harden(applyLabelingError);

/**
 * Prioritize symbols as earlier than strings.
 *
 * @param {string|symbol} a
 * @param {string|symbol} b
 * @returns {-1 | 0 | 1}
 */
const compareStringified = (a, b) => {
  if (typeof a === typeof b) {
    const left = String(a);
    const right = String(b);
    // eslint-disable-next-line no-nested-ternary
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof a === 'symbol') {
    assert(typeof b === 'string');
    return -1;
  }
  assert(typeof a === 'string');
  assert(typeof b === 'symbol');
  return 1;
};

/**
 * TODO Consolidate with the `getMethodNames` in `@endo/eventual-send`
 *
 * @param {any} val
 * @returns {(string|symbol)[]}
 */
export const getMethodNames = val => {
  let layer = val;
  const names = new Set(); // Set to deduplicate
  while (layer !== null && layer !== Object.prototype) {
    // be tolerant of non-objects
    const descs = getOwnPropertyDescriptors(layer);
    for (const name of ownKeys(descs)) {
      // In case a method is overridden by a non-method,
      // test `val[name]` rather than `layer[name]`
      if (typeof val[name] === 'function') {
        names.add(name);
      }
    }
    if (!isObject(val)) {
      break;
    }
    layer = getPrototypeOf(layer);
  }
  return harden([...names].sort(compareStringified));
};
harden(getMethodNames);

/**
 * TODO This function exists only to ease the
 * https://github.com/Agoric/agoric-sdk/pull/5970 transition, from all methods
 * being own properties to methods being inherited from a common prototype.
 * This transition breaks two patterns used in prior code: autobinding,
 * and enumerating methods by enumerating own properties. For both, the
 * preferred repairs are
 *    * autobinding: Replace, for example,
 *      `foo(obj.method)` with `foo(arg => `obj.method(arg))`. IOW, stop relying
 *      on expressions like `obj.method` to extract a method still bound to the
 *      state of `obj` because, for virtual and durable objects,
 *      they no longer will after #5970.
 *    * method enumeration: Replace, for example
 *      `Reflect.ownKeys(obj)` with `getMethodNames(obj)`.
 *
 * Once all problematic cases have been converted in this manner, this
 * `bindAllMethods` hack can and TODO should be deleted. However, we currently
 * have no reliable static way to track down and fix all autobinding sites.
 * For those objects that have not yet been fully repaired by the above two
 * techniques, `bindAllMethods` creates an object that acts much like the
 * pre-#5970 objects, with all their methods as instance-bound own properties.
 * It does this by making a new object inheriting from `obj` where the new
 * object has bound own methods overridding all the methods it would have
 * inherited from `obj`.
 *
 * @param {Remotable} obj
 * @returns {Remotable}
 */
export const bindAllMethods = obj =>
  harden(
    create(
      obj,
      fromEntries(
        getMethodNames(obj).map(name => [
          name,
          {
            value: (/** @type {unknown[]} */ ...args) =>
              apply(obj[name], obj, args),
            enumerable: true,
          },
        ]),
      ),
    ),
  );
harden(bindAllMethods);

/**
 * @template {{}} T
 * @typedef {{ [K in keyof T]: DeeplyAwaited<T[K]> }} DeeplyAwaitedObject
 */

/**
 * Caveats:
 * - doesn't recur within Promise results
 * - resulting type has wrapper in its name
 *
 * @template T
 * @typedef {T extends PromiseLike<any> ? Awaited<T> : T extends {} ? DeeplyAwaitedObject<T> : Awaited<T>} DeeplyAwaited
 */

/**
 * A more constrained version of {deeplyFulfilled} for type safety until https://github.com/endojs/endo/issues/1257
 * Useful in starting contracts that need all terms to be fulfilled in order to be durable.
 *
 * @type {<T extends {}>(unfulfilledTerms: T) => Promise<DeeplyAwaited<T>>}
 */
export const deeplyFulfilledObject = obj => {
  isObject(obj) || Fail`param must be an object`;
  return deeplyFulfilled(obj);
};

/**
 * Returns a function that uses a millisecond-based time-since-epoch capability
 * (such as `performance.now`) to measure execution time of an async function
 * and report the result in seconds to match our telemetry standard.
 *
 * @param {typeof import('perf_hooks').performance.now} currentTimeMillisec
 * @returns {<T>(fn: () => Promise<T>) => Promise<{ result: T, duration: number }>}
 */
export const makeMeasureSeconds = currentTimeMillisec => {
  /** @param {() => any} fn */
  const measureSeconds = async fn => {
    const t0 = currentTimeMillisec();
    const result = await fn();
    const durationMillisec = currentTimeMillisec() - t0;
    return { result, duration: durationMillisec / 1000 };
  };
  return measureSeconds;
};

/**
 * @param {Error[]} errors
 * @param {string} [message]
 */
export const makeAggregateError = (errors, message) => {
  const err = new Error(message);
  Object.defineProperties(err, {
    name: {
      value: 'AggregateError',
    },
    errors: {
      value: errors,
    },
  });
  return err;
};

/**
 * @template T
 * @param {readonly (T | PromiseLike<T>)[]} values
 * @returns {Promise<T[]>}
 */
export const PromiseAllOrErrors = async values => {
  return Promise.allSettled(values).then(results => {
    const errors = /** @type {PromiseRejectedResult[]} */ (
      results.filter(({ status }) => status === 'rejected')
    ).map(result => result.reason);
    if (!errors.length) {
      return /** @type {PromiseFulfilledResult<T>[]} */ (results).map(
        result => result.value,
      );
    } else if (errors.length === 1) {
      throw errors[0];
    } else {
      throw makeAggregateError(errors);
    }
  });
};

/**
 * @type {<T>(
 *   trier: () => Promise<T>,
 *  finalizer: (error?: unknown) => Promise<void>,
 * ) => Promise<T>}
 */ export const aggregateTryFinally = async (trier, finalizer) =>
  trier().then(
    async result => finalizer().then(() => result),
    async tryError =>
      finalizer(tryError)
        .then(
          () => tryError,
          finalizeError => makeAggregateError([tryError, finalizeError]),
        )
        .then(error => Promise.reject(error)),
  );

/**
 * @param {import("fs").ReadStream | import("fs").WriteStream} stream
 * @returns {Promise<void>}
 */
export const fsStreamReady = stream =>
  new Promise((resolve, reject) => {
    if (stream.destroyed) {
      reject(new Error('Stream already destroyed'));
      return;
    }

    if (!stream.pending) {
      resolve();
      return;
    }

    const onReady = () => {
      cleanup(); // eslint-disable-line no-use-before-define
      resolve();
    };

    /** @param {Error} err */
    const onError = err => {
      cleanup(); // eslint-disable-line no-use-before-define
      reject(err);
    };

    const cleanup = () => {
      stream.off('ready', onReady);
      stream.off('error', onError);
    };

    stream.on('ready', onReady);
    stream.on('error', onError);
  });

/**
 * @template {Record<string, unknown>} T
 * @typedef {{[P in keyof T]: Exclude<T[P], undefined>;}} AllDefined
 */

/**
 * Concise way to check values are available from object literal shorthand.
 * Throws error message to specify the missing values.
 *
 * @template {Record<string, unknown>} T
 * @param {T} obj
 * @throws if any value in the object entries is not defined
 * @returns {asserts obj is AllDefined<T>}
 */

export const assertAllDefined = obj => {
  const missing = [];
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined) {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    Fail`missing ${q(missing)}`;
  }
};

/** @type {IteratorResult<undefined, never>} */
const notDone = harden({ done: false, value: undefined });

/** @type {IteratorResult<never, void>} */
const alwaysDone = harden({ done: true, value: undefined });

export const forever = asyncGenerate(() => notDone);

/**
 * @template T
 * @param {() => T} produce
 * The value of `await produce()` is used for its truthiness vs falsiness.
 * IOW, it is coerced to a boolean so the caller need not bother doing this
 * themselves.
 * @returns {AsyncIterable<Awaited<T>>}
 */
export const whileTrue = produce =>
  asyncGenerate(async () => {
    const value = await produce();
    if (!value) {
      return alwaysDone;
    }
    return harden({
      done: false,
      value,
    });
  });

/**
 * @template T
 * @param {() => T} produce
 * The value of `await produce()` is used for its truthiness vs falsiness.
 * IOW, it is coerced to a boolean so the caller need not bother doing this
 * themselves.
 * @returns {AsyncIterable<Awaited<T>>}
 */
export const untilTrue = produce =>
  asyncGenerate(async () => {
    const value = await produce();
    if (value) {
      return harden({
        done: true,
        value,
      });
    }
    return harden({
      done: false,
      value,
    });
  });
