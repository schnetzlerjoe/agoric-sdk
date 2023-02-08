import { makeVatSlot, parseVatSlot } from './parseVatSlots.js';
import { enumerateKeysWithPrefix } from './vatstore-iterators.js';

// This file has tools to run during the last delivery of the old vat
// version, `dispatch.stopVat()`, just before an upgrade. It is
// responsible for deleting as much of the non-retained data as
// possible. The primary function is `releaseOldState()`, at the end;
// everything else is a helper function.

// The only data that should be retained are those durable objects and
// collections which are transitively reachable from two sets of
// roots: the durable objects exported to other vats, and the
// "baggage" collection. All other durable objects, and *all*
// merely-virtual objects (regardless of export status) should be
// deleted. All imports which were kept alive by dropped object should
// also be dropped.

// However, the possibility of cycles within durable storage means
// that a full cleanup requires a mark+sweep pass through all durable
// objects, which I think is too expensive for right now.

// So instead, I'm going to settle on a cheaper `stopVat` which
// correctly drops durable objects and imports that were only kept
// alive by 1: RAM, 2: non-durable exports, or 3: non-durable
// objects/collections. It will require a walk through all non-durable
// objects and collections, but not a mark+sweep through all durable
// objects.

// This cheaper form may leak some imports and storage, but should not
// allow the new vat to access anything it shouldn't, nor allow other
// vats to cause confusion in the new version (by referencing exports
// which the vat no longer remembers).

const rootSlot = makeVatSlot('object', true, 0n);

function rejectAllPromises({ deciderVPIDs, syscall, disconnectObjectCapData }) {
  // Pretend that userspace rejected all non-durable promises. We
  // basically do the same thing that `thenReject(p, vpid)(rejection)`
  // would have done, but we skip ahead to the syscall.resolve
  // part. The real `thenReject` also does pRec.reject(), which would
  // give control to userspace (who might have re-imported the promise
  // and attached a .then to it), and stopVat() must not allow
  // userspace to gain agency.

  const rejections = deciderVPIDs.map(vpid => [
    vpid,
    true,
    disconnectObjectCapData,
  ]);
  if (rejections.length) {
    syscall.resolve(rejections);
  }
}

// eslint-disable-next-line no-unused-vars
function finalizeEverything(tools) {
  const { slotToVal, addToPossiblyDeadSet, vreffedObjectRegistry } = tools;

  // The liveslots tables which might keep userspace objects alive
  // are:
  // * exportedRemotables
  // * importedDevices
  // * importedPromisesByPromiseID
  // * pendingPromises
  // * vrm.remotableRefCounts
  // * vrm.vrefRecognizers (which points to virtualObjectMap which
  //                        is a strong Map whose values might be
  //                        Presences or Representatives)

  // Use slotToVal to find all the Presences, Remotables, and
  // Representatives, and simulate the finalizer calls. This doesn't
  // remove those objects from RAM, but it makes liveslots
  // decref/drop/retire things as if they were.

  for (const baseRef of slotToVal.keys()) {
    const p = parseVatSlot(baseRef);
    if (p.type === 'object' && baseRef !== rootSlot) {
      const wr = slotToVal.get(baseRef);
      const val = wr.deref();
      if (val) {
        // the object is still around, so pretend it went away
        addToPossiblyDeadSet(baseRef);
        // and remove it, else scanForDeadObjects() will think it was
        // reintroduced
        slotToVal.delete(baseRef);
        // stop the real finalizer from firing
        vreffedObjectRegistry.unregister(val);
      }
      // if !wr.deref(), there should already be a finalizer call queued
    }
  }
}

// eslint-disable-next-line no-unused-vars
function deleteVirtualObjectsWithoutDecref({ vrm, syscall }) {
  // delete the data of all non-durable virtual objects, without
  // attempting to decrement the refcounts of the surviving
  // imports/durable-objects they might point to

  const prefix = 'vom.o+';
  for (const key of enumerateKeysWithPrefix(syscall, prefix)) {
    const baseRef = key.slice('vom.'.length);
    const p = parseVatSlot(baseRef);
    if (!vrm.isDurableKind(p.id)) {
      syscall.vatstoreDelete(key);
    }
  }
}

// BEGIN: the following functions aren't ready for use yet

// eslint-disable-next-line no-unused-vars
function deleteVirtualObjectsWithDecref({ syscall, vrm }) {
  // Delete the data of all non-durable objects, building up a list of
  // decrefs to apply to possibly-surviving imports and durable
  // objects that the late virtual objects pointed to. We don't need
  // to tell the kernel that we're deleting these: we already
  // abandoned any that were exported.

  const durableDecrefs = new Map(); // baseRef -> count
  const importDecrefs = new Map(); // baseRef -> count
  const prefix = 'vom.o+';

  for (const key of enumerateKeysWithPrefix(syscall, prefix)) {
    const value = syscall.vatstoreGet(key);
    const baseRef = key.slice('vom.'.length);
    const p = parseVatSlot(baseRef);
    if (!vrm.isDurableKind(p.id)) {
      const raw = JSON.parse(value);
      for (const capdata of Object.values(raw)) {
        for (const vref of capdata.slots) {
          const p2 = parseVatSlot(vref);
          if ((p2.virtual || p2.durable) && vrm.isDurableKind(p2.id)) {
            const count = durableDecrefs.get(p2.baseRef) || 0;
            durableDecrefs.set(p2.baseRef, count + 1);
          }
          if (!p2.allocatedByVat) {
            const count = importDecrefs.get(p2.baseRef) || 0;
            importDecrefs.set(p2.baseRef, count + 1);
          }
        }
      }
      syscall.vatstoreDelete(key);
    }
  }

  // now decrement the DOs and imports that were held by the VOs,
  // applying the whole delta at once (instead of doing multiple
  // single decrefs)
  const durableBaserefs = Array.from(durableDecrefs.keys()).sort();
  for (const baseRef of durableBaserefs) {
    // @ts-expect-error FIXME .get does not exist on array
    vrm.decRefCount(baseRef, durableBaserefs.get(baseRef));
  }

  const importVrefs = Array.from(importDecrefs.keys()).sort();
  for (const baseRef of importVrefs) {
    vrm.decRefCount(baseRef, importDecrefs.get(baseRef));
  }
}

// eslint-disable-next-line no-unused-vars
function deleteCollectionsWithDecref({ syscall, vrm }) {
  // TODO this is not ready yet

  // Delete all items of all non-durable collections, counting up how
  // many references their values had to imports and durable objects,
  // so we can decref them in a large chunk at the end.

  // Walk prefix='vc.', extract vc.NN., look up whether collectionID
  // NN is durable or not, skip the durables, delete the vc.NN.|
  // metadata keys, walk the remaining vc.NN. keys, JSON.parse each,
  // extract slots, update decrefcounts, delete

  // TODO: vrefs used as keys may maintain a refcount, and need to be
  // handled specially. This code will probably get confused by such
  // entries.

  const durableDecrefs = new Map(); // baseRef -> count
  const importDecrefs = new Map(); // baseRef -> count
  const prefix = 'vom.vc.';

  for (const key of enumerateKeysWithPrefix(syscall, prefix)) {
    const value = syscall.vatstoreGet(key);
    const subkey = key.slice(prefix.length); // '2.|meta' or '2.ENCKEY'
    const collectionID = subkey.slice(0, subkey.index('.')); // string
    const subsubkey = subkey.slice(collectionID.length); // '|meta' or 'ENCKEY'
    const isMeta = subsubkey.slice(0, 1) === '|';
    const isDurable = 'TODO'; // ask collectionManager about collectionID
    if (!isDurable && !isMeta) {
      for (const vref of JSON.parse(value).slots) {
        const p = parseVatSlot(vref);
        if ((p.virtual || p.durable) && vrm.isDurableKind(p.id)) {
          const count = durableDecrefs.get(p.baseRef) || 0;
          durableDecrefs.set(p.baseRef, count + 1);
        }
        if (!p.allocatedByVat) {
          const count = importDecrefs.get(p.baseRef) || 0;
          importDecrefs.set(p.baseRef, count + 1);
        }
      }
    }
    syscall.vatstoreDelete(key);
  }
  const durableBaserefs = Array.from(durableDecrefs.keys()).sort();
  for (const baseRef of durableBaserefs) {
    // @ts-expect-error FIXME .get does not exist on array
    vrm.decRefCount(baseRef, durableBaserefs.get(baseRef));
  }

  const importVrefs = Array.from(importDecrefs.keys()).sort();
  for (const baseRef of importVrefs) {
    vrm.decRefCount(baseRef, importDecrefs.get(baseRef));
  }
}

// END: the preceding functions aren't ready for use yet

export async function releaseOldState(tools) {
  // First, pretend that userspace has rejected all non-durable
  // promises, so we'll resolve them into the kernel (and retire their
  // IDs).

  rejectAllPromises(tools);

  // The kernel will abandon all non-durable exports once we're
  // done. TODO: one drawback of having the kernel do this, instead of
  // us (stopVat), is that we don't see any refcount decrements which
  // might let us drop virtuals/durables from the DB, or objects from
  // RAM which might then drop virtuals/durables from the DB.

  // bringOutYourDead remains to ensure that the LRU cache is flushed,
  // but the rest of this function has been disabled to improve stop-vat
  // performance.
  // eslint-disable-next-line no-use-before-define
  await tools.bringOutYourDead();

  /* We expect that in the fullness of time the following will be superseded by a
   * post-upgrade scavenger process that cleans up dead database debris
   * incrementally, rather than taking the hit of a potentially large delay at
   * shutdown time.  If that change happens, the below code can simply be
   * removed.  Until then, I'm leaving it in place as scaffolding, just in case,
   * on the theory that it will be easier to reconstruct as a unified whole
   * without having to navigate through a confusing maze of twisty git branches.

  // Then we pretend userspace RAM has dropped all the vref-based
  // objects that it was holding onto.
  finalizeEverything(tools);

  // Now we ask collectionManager for help with deleting all
  // non-durable collections. This will delete all the DB entries
  // (including the metadata), decref everything they point to,
  // including imports and DOs, and add to possiblyDeadSet. There
  // might still be a Presence for the collection in RAM, but if/when
  // it is deleted, the collectionManager will tolerate (ignore) the
  // resulting attempt to free all the entries a second time.

  tools.collectionManager.deleteAllVirtualCollections();

  // Now we'll have finalizers pending and `possiblyDeadSet` will be
  // populated with our simulated drops, so a `bringOutYourDead` will
  // release a lot.

  // eslint-disable-next-line no-use-before-define
  await tools.bringOutYourDead();

  // possiblyDeadSet is now empty

  // NOTE: instead of using deleteAllVirtualCollections() above (which
  // does a lot of decref work we don't really care about), we might
  // use deleteCollectionsWithDecref() here, once it's ready. It
  // should be faster because it doesn't need to care about refcounts
  // of virtual objects or Remotables, only those of imports and
  // durables. But it bypasses the usual refcounting code, so it
  // should probably be called after the last BOYD.
  //
  // deleteCollectionsWithDecref(tools);

  // The remaining data is virtual objects which participate in cycles
  // (although not through virtual collections, which were deleted
  // above), durable objects held by [those virtual objects, durable
  // object cycles, exports, or baggage], and imports held by all of
  // those.

  // eslint-disable-next-line no-constant-condition
  if (1) {
    // We delete the data of all merely-virtual objects. For now, we
    // don't attempt to decrement the refcounts of things they point
    // to (which might allow us to drop some imports and a subset of
    // the durable objects).
    deleteVirtualObjectsWithoutDecref(tools);

    // The remaining data is durable objects which were held by
    // virtual-object cycles, or are still held by durable-object
    // cycles or exports or baggage, and imports held by all of those.

    // At this point we declare sufficient victory and return.
  } else {
    // We delete the data of all merely-virtual objects, and
    // accumulate counts of the deleted references to durable objects
    // and imports (ignoring references to Remotables and other
    // virtual objects). After deletion, we apply the decrefs, which
    // may cause some durable objects and imports to be added to
    // possiblyDeadSet.
    deleteVirtualObjectsWithDecref(tools);

    // possiblyDeadSet will now have baserefs for durable objects and
    // imports (the ones that were only kept alive by virtual-object
    // cycles). There won't be any virtual-object baserefs in
    // possiblyDeadSet because we didn't apply any of those
    // decrefs. So our `bringOutYourDead` won't try to read or modify
    // any of the on-disk refcounts for VOs (which would fail because
    // we deleted everything).

    // eslint-disable-next-line no-use-before-define
    await tools.bringOutYourDead();

    // The remaining data is durable objects which are held by a
    // durable-object cycle, exports, or baggage, and imports held by
    // all of those.

    // At this point we declare sufficient victory and return.
  }

  */
}
