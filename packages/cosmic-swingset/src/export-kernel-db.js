#! /usr/bin/env node

// @ts-check
import '@endo/init';

import os from 'os';
import process from 'process';
import fs from 'fs/promises';
import { resolve as pathResolve } from 'path';

import { openSwingStore } from '@agoric/swing-store';
import { Fail } from '@agoric/assert';

import { isEntrypoint } from './helpers/is-entrypoint.js';
import { makeProcessValue } from './helpers/process-value.js';
import { makeSwingStoreExporter } from './helpers/swingstore-exporter.js';

export const main = async (args, { env, homedir, send, console }) => {
  const processValue = makeProcessValue({ env, args });

  const stateDir =
    processValue.getFlag('state-dir') ||
    // We try to find the actual cosmos state directory (default=~/.ag-chain-cosmos)
    `${processValue.getFlag(
      'home',
      `${homedir}/.ag-chain-cosmos`,
    )}/data/ag-cosmos-chain-state`;

  const stateDirStat = await fs.stat(stateDir);
  if (!stateDirStat.isDirectory()) {
    throw new Error('state-dir must be an exiting directory');
  }

  const exportDir = pathResolve(
    /** @type {string} */ (processValue.getFlag('export-dir', '.')),
  );
  const manifestPath = pathResolve(exportDir, 'export-manifest.json');
  const manifestFile = await fs.open(manifestPath, 'wx');

  const includeKVData = processValue.getBoolean({
    flagName: 'include-kv-data',
  });
  const includeHistoricalArtifacts = processValue.getBoolean({
    flagName: 'include-historical',
  });

  const checkBlockHeight = processValue.getInteger({
    flagName: 'check-block-height',
  });

  const swingStoreExporter = makeSwingStoreExporter(stateDir);

  const { hostStorage } = openSwingStore(stateDir);

  const savedBlockHeight = Number(hostStorage.kvStore.get('host.height')) || 0;
  await hostStorage.close();

  if (checkBlockHeight !== undefined) {
    checkBlockHeight === savedBlockHeight ||
      Fail`DB at unexpected block height ${savedBlockHeight} (expected ${checkBlockHeight})`;
  }

  send?.({ type: 'ready' });
  console.log(`Starting DB export at block height ${savedBlockHeight}`);

  const manifest = {
    blockHeight: savedBlockHeight,
  };

  await (includeKVData &&
    (async () => {
      console.log(`Writing KV Data`);
      const kvData = {};
      for await (const [key, value] of swingStoreExporter.getKVData()) {
        kvData[key] = value;
      }

      const fileName = `kvData.json`;

      await fs.writeFile(
        pathResolve(exportDir, fileName),
        JSON.stringify(kvData, null, 2),
      );
      manifest.kvData = fileName;
    })());

  const getArtifacts = async kind => {
    const includeHistorical = kind === 'historical';
    const includeRequired = kind === 'required';
    const artifacts = {};
    for await (const artifactName of swingStoreExporter.getArtifactNames({
      includeHistorical,
      includeRequired,
    })) {
      console.log(`Writing ${kind} artifact: ${artifactName}`);
      const artifactData = swingStoreExporter.getArtifact(artifactName);
      await fs.writeFile(pathResolve(exportDir, artifactName), artifactData);
      artifacts[artifactName] = artifactName;
    }
    return harden(artifacts);
  };
  manifest.artifacts = await getArtifacts('required');
  if (includeHistoricalArtifacts) {
    // eslint-disable-next-line @jessie.js/no-nested-await
    manifest.historicalArtifacts = await getArtifacts('historical');
  }

  await manifestFile.write(JSON.stringify(manifest, null, 2));
  await manifestFile.close();
  console.log(`Saved export manifest: ${manifestPath}`);

  send?.({ type: 'done' });
};

if (isEntrypoint(import.meta.url)) {
  main(process.argv.splice(2), {
    homedir: os.homedir(),
    env: process.env,
    send: process.send
      ? Function.prototype.bind.call(process.send, process)
      : undefined,
    console,
  }).then(
    _res => 0,
    rej => {
      console.error(`error running export-kernel-db:`, rej);
      process.exit(process.exitCode || rej.exitCode || 1);
    },
  );
}
