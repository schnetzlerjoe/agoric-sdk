// @ts-check

import { E } from '@endo/far';
import { M, ephemeralZone } from '@agoric/zone';

const { Fail } = assert;

/** @typedef {ReturnType<typeof import('@endo/marshal').makeMarshal>} Marshaller */
/** @typedef {Pick<Marshaller, 'unserialize'>} Unserializer */

/**
 * Defined by vstorageStoreKey in vstorage.go
 *
 * @typedef VStorageKey
 * @property {string} storeName
 * @property {string} storeSubkey
 * @property {string} dataPrefixBytes
 */

/**
 * This represents a node in an IAVL tree.
 *
 * The active implementation is x/vstorage, an Agoric extension of the Cosmos SDK.
 *
 * Vstorage is a hierarchical externally-reachable storage structure that
 * identifies children by restricted ASCII name and is associated with arbitrary
 * string-valued data for each node, defaulting to the empty string.
 *
 * @typedef {object} StorageNode
 * @property {(data: string) => Promise<void>} setValue publishes some data
 * @property {() => string} getPath the chain storage path at which the node was constructed
 * @property {() => Promise<VStorageKey>} getStoreKey DEPRECATED use getPath
 * @property {(subPath: string, options?: {sequence?: boolean}) => StorageNode} makeChildNode
 */

const ChainStorageNodeI = M.interface('StorageNode', {
  setValue: M.callWhen(M.string()).returns(),
  getPath: M.call().returns(M.string()),
  getStoreKey: M.callWhen().returns(M.record()),
  makeChildNode: M.call(M.string())
    .optional(M.record())
    .returns(M.remotable('StorageNode')),
});

/**
 * @typedef {object} StoredFacet
 * @property {() => Promise<string>} getPath the chain storage path at which the node was constructed
 * @property {StorageNode['getStoreKey']} getStoreKey DEPRECATED use getPath
 * @property {() => Unserializer} getUnserializer get the unserializer for the stored data
 */

// TODO: Formalize segment constraints.
// Must be nonempty and disallow (unescaped) `.`, and for simplicity
// (and future possibility of e.g. escaping) we currently limit to
// ASCII alphanumeric plus underscore and dash.
const pathSegmentPattern = /^[a-zA-Z0-9_-]{1,100}$/;

/** @type {(name: string) => void} */
export const assertPathSegment = name => {
  pathSegmentPattern.test(name) ||
    Fail`Path segment names must consist of 1 to 100 characters limited to ASCII alphanumerics, underscores, and/or dashes: ${name}`;
};
harden(assertPathSegment);

/**
 * Must match the switch in vstorage.go using `vstorageMessage` type
 *
 * @typedef {'get' | 'getStoreKey' | 'set' | 'append' | 'has' |'entries' | 'values' |'size' } StorageMessageMethod
 * @typedef {{key: string, method: StorageMessageMethod, value: string}} StorageMessage
 */

/**
 * Create a root storage node for a given backing function and root path.
 *
 * @param {(message: StorageMessage) => any} handleStorageMessage a function for sending a storageMessage object to the storage implementation (cf. golang/cosmos/x/vstorage/vstorage.go)
 * @param {string} rootPath
 * @param {object} [rootOptions]
 * @param {boolean} [rootOptions.sequence] employ a wrapping structure that preserves each value set within a single block, and default child nodes to do the same
 * @param {import('@agoric/zone').Zone} [rootOptions.zone] the zone in which to
 * allocate the storage node
 */
export function makeChainStorageRoot(
  handleStorageMessage,
  rootPath,
  rootOptions = {},
) {
  assert.typeof(rootPath, 'string');
  const { zone = ephemeralZone } = rootOptions;

  /**
   * @param {string} path
   * @param {object} [options]
   * @param {boolean} [options.sequence]
   * @returns {StorageNode}
   */
  const makeChainStorageNode = zone.exoClass(
    'ChainStorageNode',
    ChainStorageNodeI,
    /**
     * @param {string} path
     * @param {object} [options]
     * @param {boolean} [options.sequence]
     */
    (path, { sequence = false } = {}) => harden({ path, sequence }),
    {
      getPath() {
        return this.state.path;
      },
      /**
       * @deprecated use getPath
       * @type {() => Promise<VStorageKey>}
       */
      async getStoreKey() {
        return handleStorageMessage({
          key: this.state.path,
          method: 'getStoreKey',
          value: '',
        });
      },
      /** @type {(name: string, childNodeOptions?: {sequence?: boolean}) => StorageNode} */
      makeChildNode(name, childNodeOptions = {}) {
        const { sequence, path } = this.state;
        assert.typeof(name, 'string');
        assertPathSegment(name);
        const mergedOptions = { sequence, ...childNodeOptions };
        return makeChainStorageNode(`${path}.${name}`, mergedOptions);
      },
      /** @type {(value: string) => Promise<void>} */
      async setValue(value) {
        const { sequence, path } = this.state;
        assert.typeof(value, 'string');
        await handleStorageMessage({
          key: path,
          method: sequence ? 'append' : 'set',
          value,
        });
      },
      // Possible extensions:
      // * getValue()
      // * getChildNames() and/or makeChildNodes()
      // * getName()
      // * recursive delete
      // * batch operations
      // * local buffering (with end-of-block commit)
    },
  );

  const rootNode = makeChainStorageNode(rootPath, rootOptions);
  return rootNode;
}

/**
 * @returns {StorageNode} an object that confirms to StorageNode API but does not store anywhere.
 */
const makeNullStorageNode = () => {
  // XXX re-use "ChainStorage" methods above which don't actually depend on chains
  return makeChainStorageRoot(() => null, 'null');
};

/**
 * Convenience function for returning a storage node at or under its input,
 * falling back to an inert object with the correct interface (but incomplete
 * behavior) when that is unavailable.
 *
 * @param {import('@endo/far').ERef<StorageNode?>} storageNodeRef
 * @param {string} childName
 * @returns {Promise<StorageNode>}
 */
export async function makeStorageNodeChild(storageNodeRef, childName) {
  const existingStorageNode = await storageNodeRef;
  const storageNode = existingStorageNode || makeNullStorageNode();
  return E(storageNode).makeChildNode(childName);
}
harden(makeStorageNodeChild);

// TODO find a better module for this
/**
 *
 * @param {import('@endo/far').ERef<StorageNode>} storageNode
 * @param {import('@endo/far').ERef<Marshaller>} marshaller
 * @returns {(value: unknown) => Promise<void>}
 */
export const makeSerializeToStorage = (storageNode, marshaller) => {
  return async value => {
    const marshalled = await E(marshaller).serialize(value);
    const serialized = JSON.stringify(marshalled);
    return E(storageNode).setValue(serialized);
  };
};
