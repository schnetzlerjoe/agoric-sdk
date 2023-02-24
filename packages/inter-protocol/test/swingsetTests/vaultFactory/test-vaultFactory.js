import '@endo/init/debug.js';
import anyTest from 'ava';
import path from 'path';
import { buildVatController, buildKernelBundles } from '@agoric/swingset-vat';
import bundleSource from '@endo/bundle-source';
import { E } from '@endo/eventual-send';
import zcfBundle from '@agoric/zoe/bundles/bundle-contractFacet.js';
import committeeBundle from '@agoric/governance/bundles/bundle-committee.js';
import contractGovernorBundle from '@agoric/governance/bundles/bundle-contractGovernor.js';
import binaryVoteCounterBundle from '@agoric/governance/bundles/bundle-binaryVoteCounter.js';

import vaultFactoryBundle from '../../../bundles/bundle-vaultFactory.js';

/** @type {import('ava').TestFn<{ data: { kernelBundles: any, config: any } }>} */
const test = anyTest;

/**
 *
 * @param {Record<string, unknown>} contractBundles
 * @param {string[]} vatNames
 * @returns {Promise<SwingSetConfig>}
 */
export const buildSwingSetConfig = async (contractBundles, vatNames) => {
  const filename = new URL(import.meta.url).pathname;
  const dirname = path.dirname(filename);

  const vatNameToSource = vatNames.map(name => {
    const source = `${dirname}/vat-${name}.js`;
    return [name, source];
  });
  const bootstrapSource = `${dirname}/bootstrap.js`;
  vatNameToSource.push(['bootstrap', bootstrapSource]);

  const bundles = await Promise.all(
    vatNameToSource.map(([_, source]) => bundleSource(source)),
  );

  /** @type {SwingSetConfigDescriptor} */
  const vats = {};
  [...vatNames, 'bootstrap'].forEach(
    (name, index) => (vats[name] = { bundle: bundles[index] }),
  );
  vats.bootstrap.parameters = { contractBundles };

  const config = { bootstrap: 'bootstrap', vats };
  config.bundles = { zcf: { bundle: zcfBundle } };
  config.defaultManagerType = 'xs-worker';
  return config;
};

test.before(async t => {
  const kernelBundles = await buildKernelBundles();

  const contractBundles = {
    vaultFactory: vaultFactoryBundle,
    committee: committeeBundle,
    contractGovernor: contractGovernorBundle,
    binaryVoteCounter: binaryVoteCounterBundle,
  };

  const vatNames = ['alice', 'zoe', 'priceAuthority', 'owner'];

  const config = await buildSwingSetConfig(contractBundles, vatNames);

  t.context.data = { kernelBundles, config };
});

async function main(t, argv) {
  const { kernelBundles, config } = t.context.data;
  const controller = buildVatController(config, argv, { kernelBundles });
  t.teardown(() => E(controller).shutdown());
  await E(controller).run();
  return E(controller).dump();
}

// NB: yarn build if changing any of the contract bundles under test
// TODO(#5433) reinstate or convert to non-swingset test
test.skip('vaultFactory', async t => {
  const startingValues = [[100], [1000]]; // [aliceValues, ownerValues]
  const dump = await main(t, ['oneLoanWithInterest', startingValues]);
  t.deepEqual(dump.log, [
    '=> alice and the vaultFactory are set up',
    '=> alice.oneLoanWithInterest called',
    'Alice owes {"brand":"[Alleged: IST brand]","value":"[510000n]"} after borrowing',
    'Alice owes {"brand":"[Alleged: IST brand]","value":"[510035n]"} after interest',
  ]);
});
