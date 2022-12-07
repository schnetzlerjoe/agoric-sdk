// @ts-check

import { E, Far } from '@endo/far';

const { Fail } = assert;

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
 * @param {'swingset'} storeName currently limited to "swingset"
 * @param {string} rootPath
 * @param {object} [rootOptions]
 * @param {boolean} [rootOptions.sequence] employ a wrapping structure that preserves each value set within a single block, and default child nodes to do the same
 */
export function makeChainStorageRoot(
  handleStorageMessage,
  storeName,
  rootPath,
  rootOptions = {},
) {
  assert.equal(
    storeName,
    'swingset',
    'the only currently-supported store is "swingset"',
  );
  assert.typeof(rootPath, 'string');

  function makeChainStorageNode(path, options = {}) {
    const { sequence = false } = options;
    const node = {
      /** @type {() => VStorageKey} */
      getStoreKey() {
        return handleStorageMessage({
          key: path,
          method: 'getStoreKey',
          value: '',
        });
      },
      /** @type {(name: string, childNodeOptions?: {sequence?: boolean}) => StorageNode} */
      makeChildNode(name, childNodeOptions = {}) {
        assert.typeof(name, 'string');
        assertPathSegment(name);
        const mergedOptions = { sequence, ...childNodeOptions };
        return makeChainStorageNode(`${path}.${name}`, mergedOptions);
      },
      /** @type {(value: string) => Promise<void>} */
      setValue: async valueP => {
        const value = await valueP;
        assert.typeof(value, 'string');
        handleStorageMessage({
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
    };
    return Far('chainStorageNode', node);
  }

  const rootNode = makeChainStorageNode(rootPath, rootOptions);
  return rootNode;
}

/**
 * @returns {StorageNode} an object that confirms to StorageNode API but does not store anywhere.
 */
const makeNullStorageNode = () => {
  // XXX re-use "ChainStorage" methods above which don't actually depend on chains
  return makeChainStorageRoot(() => null, 'swingset', 'null');
};

/**
 * Convenience function for returning a storage node at or under its input,
 * falling back to an inert object with the correct interface (but incomplete
 * behavior) when that is unavailable.
 *
 * @param {ERef<StorageNode?>} storageNodeRef
 * @param {string} childName
 * @returns {Promise<StorageNode>}
 */
export async function makeStorageNodeChild(storageNodeRef, childName) {
  // eslint-disable-next-line @jessie.js/no-nested-await
  const storageNode = (await storageNodeRef) || makeNullStorageNode();
  return E(storageNode).makeChildNode(childName);
}
harden(makeStorageNodeChild);
