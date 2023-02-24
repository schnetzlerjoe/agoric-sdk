import '@agoric/zoe/exported.js';
import { test as unknownTest } from '@agoric/zoe/tools/prepare-test-env-ava.js';

import { makeTracer } from '@agoric/internal';
import { E } from '@endo/eventual-send';
import '../../src/vaultFactory/types.js';
import { assertTopicPathData, subscriptionKey } from '../supports.js';
import { makeDriverContext, makeManagerDriver } from './driver.js';

/** @typedef {import('./driver.js').DriverContext & {
 * }} Context */
/** @type {import('ava').TestFn<Context>} */
const test = unknownTest;

const trace = makeTracer('TestLiq', false);

test.before(async t => {
  t.context = await makeDriverContext();
  trace(t, 'CONTEXT');
});

test('storage keys', async t => {
  const { aeth, run } = t.context;
  const d = await makeManagerDriver(t);

  // Root vault factory
  const vdp = d.getVaultDirectorPublic();
  await assertTopicPathData(
    t,
    vdp,
    'metrics',
    'mockChainStorageRoot.vaultFactory.metrics',
    ['collaterals', 'rewardPoolAllocation'],
  );
  t.is(
    await subscriptionKey(E(vdp).getElectorateSubscription()),
    'mockChainStorageRoot.vaultFactory.governance',
  );

  // First manager
  const managerA = await E(vdp).getCollateralManager(aeth.brand);
  await assertTopicPathData(
    t,
    managerA,
    'asset',
    'mockChainStorageRoot.vaultFactory.manager0',
    [
      'compoundedInterest',
      'interestRate',
      'latestInterestUpdate',
      'liquidatorInstance',
    ],
  );
  await assertTopicPathData(
    t,
    managerA,
    'metrics',
    'mockChainStorageRoot.vaultFactory.manager0.metrics',
    [
      'numActiveVaults',
      'numLiquidatingVaults',
      'numLiquidationsCompleted',
      'totalCollateral',
      'totalCollateralSold',
      'totalDebt',
      'totalOverageReceived',
      'totalProceedsReceived',
      'totalShortfallReceived',
    ],
  );
  t.is(
    await subscriptionKey(
      E(vdp).getSubscription({
        collateralBrand: aeth.brand,
      }),
    ),
    'mockChainStorageRoot.vaultFactory.manager0.governance',
  );

  // Second manager
  const [managerC, chit] = await d.addVaultType('Chit');
  await assertTopicPathData(
    t,
    E(managerC).getPublicFacet(),
    'asset',
    'mockChainStorageRoot.vaultFactory.manager1',
  );
  await assertTopicPathData(
    t,
    E(managerC).getPublicFacet(),
    'metrics',
    'mockChainStorageRoot.vaultFactory.manager1.metrics',
  );
  t.is(
    await subscriptionKey(
      E(vdp).getSubscription({
        collateralBrand: chit.brand,
      }),
    ),
    'mockChainStorageRoot.vaultFactory.manager1.governance',
  );

  // First aeth vault
  const vda1 = await d.makeVaultDriver(aeth.make(1000n), run.make(50n));
  t.is(
    await E.get(vda1.getVaultSubscriber()).storagePath,
    'mockChainStorageRoot.vaultFactory.manager0.vaults.vault0',
  );

  // Second aeth vault
  const vda2 = await d.makeVaultDriver(aeth.make(1000n), run.make(50n));
  t.is(
    await E.get(vda2.getVaultSubscriber()).storagePath,
    'mockChainStorageRoot.vaultFactory.manager0.vaults.vault1',
  );
});

test('quotes storage', async t => {
  const { aeth, run } = t.context;
  const d = await makeManagerDriver(t);

  const aethManager = await E(d.getVaultDirectorPublic()).getCollateralManager(
    aeth.brand,
  );

  const storedNotifier = await E(aethManager).getQuotes();
  t.is(
    await E(storedNotifier).getPath(),
    'mockChainStorageRoot.vaultFactory.manager0.quotes',
  );

  let latest = await E(storedNotifier).getUpdateSince();
  t.deepEqual(Object.keys(latest), ['updateCount', 'value']);
  let quoteValue = latest.value.quoteAmount.value[0];
  t.deepEqual(quoteValue.amountIn, aeth.make(1n));
  t.deepEqual(quoteValue.amountOut, run.make(5n));

  const base = 100n; // driver's Aeth base price is 100
  const highPrice = 1234n;
  d.setPrice(run.make(highPrice * base));
  latest = await E(storedNotifier).getUpdateSince();
  quoteValue = latest.value.quoteAmount.value[0];
  t.log(
    quoteValue,
    quoteValue.amountOut.value,
    quoteValue.amountIn.value,
    quoteValue.amountOut.value / quoteValue.amountIn.value,
  );
  // @ts-expect-error thinks the left argument is Number
  t.is(quoteValue.amountOut.value / quoteValue.amountIn.value, highPrice);
});
