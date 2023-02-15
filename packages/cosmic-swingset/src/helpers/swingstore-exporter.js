// @ts-check
import { Buffer } from 'buffer';
import { createReadStream } from 'fs';

import { openSwingStore } from '@agoric/swing-store';
import { Fail } from '@agoric/assert';
import { makePromiseKit } from '@endo/promise-kit';

/**
 * @typedef {readonly [
 *   key: string,
 *   value: string | null,
 * ]} KVDataEntry
 *
 * @typedef {object} SwingStoreExporter
 * Allows to export data from a swingStore as a fixed view onto the content as
 * of the most recent commit point when the exporter was created.
 * The exporter may be used while another SwingStore instance is active for the
 * same DB, possibly in another thread or process.
 * It guarantees that regardless of the concurrent activity of other swingStore
 * instances, the data representing the commit point will stay consistent and
 * available.
 *
 * @property {() => AsyncIterableIterator<KVDataEntry>} getKVData
 * Get a full dump of KV data from the swingStore. This represent both the
 * KVStore (excluding host and local prefixes), as well as any data needed to
 * validate all artifacts, both current and historical. As such it represents
 * the root of trust for the application.
 * Likely content of validation data (with supporting entries for indexing):
 * - lastStartPos.${vatID} = ${startPos}
 * - transcript.${vatID}.${startPos} = ${endPos}-${rollingHash}
 * - heap-snapshot.${vatID}.${startPos} = ${hash}
 *
 * @property {(options: {includeHistorical?: boolean, includeRequired?: boolean}) => AsyncIterableIterator<string>} getArtifactNames
 * Get a list of name of artifacts available from the swingStore
 * A name returned by this method guarantees that a call to `getArtifact` on
 * the same exporter instance will succeed. Options control the filtering of
 * the artifact names yielded.
 * Likely artifact names:
 * - transcript-${vatID}-${startPos}-${endPos}
 * - heap-snapshot-${vatID}-${startPos}
 *
 * @property {(name: string) => AsyncIterableIterator<Uint8Array>} getArtifact
 * Retrieve an artifact by name. May reject if the artifact is not available,
 * which may occur if the artifact is historical and hasn't been preserved.
 *
 * @property {() => Promise<void>} close
 * Dispose of all resources held by this exporter. Any further operation on
 * this exporter or its outstanding iterators will fail.
 */

// TODO: replace with the real thing
/**
 * @param {string} dbDir
 * @returns {SwingStoreExporter}
 */
export const makeSwingStoreExporter = dbDir => {
  const {
    kernelStorage,
    hostStorage,
    debug: { getDB },
  } = openSwingStore(dbDir);
  const { kvStore, streamStore, snapStore } = kernelStorage;

  const getRequired = key => {
    kvStore.has(key) || Fail`storage lacks required key ${key}`;
    return /** @type {string} */ (kvStore.get(key));
  };

  if (!snapStore) {
    throw Fail`No snapstore`;
  }

  {
    const db = getDB();
    if (!db) {
      throw Fail`DB not available`;
    }
    db.prepare('BEGIN TRANSACTION').run();
    if (!db.inTransaction) {
      throw Fail`Couldn't start DB read transaction`;
    }
  }

  const nextVatID = BigInt(getRequired(`vat.nextID`));

  /** @type {SwingStoreExporter['getKVData']}  */
  const getKVData = async function* getKVData() {
    /** @type {string | undefined} */
    let key = '';
    while (true) {
      key = kernelStorage.kvStore.getNextKey(key);
      if (!key) return;
      if (key.startsWith(`local.`) || key.startsWith(`host.`)) continue;
      const value = /** @type {string} */ (kernelStorage.kvStore.get(key));
      yield /** @type {const} */ ([key, value]);
    }
  };

  /** @type {SwingStoreExporter['getArtifactNames']}  */
  const getArtifactNames = async function* getArtifactNames({
    includeHistorical = false,
    includeRequired = true,
  }) {
    if (includeRequired) {
      for (let i = 1n; i < nextVatID; i += 1n) {
        const vatID = `v${i}`;
        if (!kvStore.has(`${vatID}.o.nextID`)) {
          continue;
        }

        const { endPos: snapPos = -1 } = snapStore.getSnapshotInfo(vatID) || {};

        if (snapPos >= 0) {
          yield `heap-snapshot-${vatID}-${snapPos}`;
        }

        const transcriptSegmentStartPos = snapPos + 1;
        const endPos = Number(getRequired(`${vatID}.t.endPosition`));

        if (endPos >= transcriptSegmentStartPos) {
          yield `transcript-${vatID}-${transcriptSegmentStartPos}-${endPos}`;
        }
      }
    }

    if (includeHistorical) {
      throw Fail`Unsupported option "includeHistorical"`;
    }
  };

  /**
   * @param {string} vatID
   * @param {number} snapPos
   * @yields {Buffer}
   */
  const getSnapshotArtifact = async function* getSnapshotArtifact(
    vatID,
    snapPos,
  ) {
    const snapshotInfo = snapStore.getSnapshotInfo(vatID);
    snapshotInfo.endPos === snapPos ||
      Fail`Cannot retrieve historical snapshot at pos ${snapPos} for ${vatID}`;

    /** @type {import('@endo/promise-kit').PromiseKit<import('stream').Readable>} */
    const snapStreamKit = makePromiseKit();
    /** @type {import('@endo/promise-kit').PromiseKit<void>} */
    const doneKit = makePromiseKit();

    const loadResult = snapStore.loadSnapshot(vatID, async tmpFile => {
      snapStreamKit.resolve(createReadStream(tmpFile));
      return doneKit.promise;
    });

    loadResult.catch(snapStreamKit.reject);

    const snapStream = await snapStreamKit.promise;

    try {
      yield* snapStream;
    } finally {
      doneKit.resolve();
    }
    await loadResult;
  };

  /**
   * @param {string} vatID
   * @param {number} startPos
   * @param {number} endPos
   * @yields {Buffer}
   */
  const getTranscriptArtifact = async function* getTranscriptArtifact(
    vatID,
    startPos,
    endPos,
  ) {
    if (startPos === 0) {
      const source = JSON.parse(getRequired(`${vatID}.source`));
      const entry = JSON.stringify({ type: 'create-vat', vatID, source });
      yield Buffer.from(`${entry}\n`, 'utf-8');
    }

    const stream = streamStore.readStream(
      `transcript-${vatID}`,
      Math.max(0, startPos - 1),
      endPos,
    );

    for (const entry of stream) {
      yield Buffer.from(`${entry}\n`, 'utf-8');
    }
  };

  /** @type {SwingStoreExporter['getArtifact']}  */
  const getArtifact = async function* getArtifact(name) {
    const parts = name.split('-');

    if (parts[0] === 'heap' && parts[1] === 'snapshot') {
      const vatID = parts[2];
      const snapPos = Number.parseInt(parts[3], 10);

      yield* getSnapshotArtifact(vatID, snapPos);
    } else if (parts[0] === 'transcript') {
      const vatID = parts[1];
      const startPos = Number.parseInt(parts[2], 10);
      const endPos = Number.parseInt(parts[3], 10);

      yield* getTranscriptArtifact(vatID, startPos, endPos);
    } else {
      throw Fail`Unknown artifact name ${name}`;
    }
  };

  /** @type {SwingStoreExporter['close']}  */
  const close = async () => {
    await hostStorage.close();
  };

  return harden({ getKVData, getArtifactNames, getArtifact, close });
};
