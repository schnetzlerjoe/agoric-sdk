import '@agoric/zoe/exported.js';
import { test as unknownTest } from '@agoric/zoe/tools/prepare-test-env-ava.js';

import { AmountMath, AssetKind, makeIssuerKit } from '@agoric/ertp';
import { makeParamManagerBuilder } from '@agoric/governance';
import { makeTracer, objectMap } from '@agoric/internal';
import {
  makeNotifierFromAsyncIterable,
  makeNotifierFromSubscriber,
  makeStoredPublisherKit,
} from '@agoric/notifier';
import { M, matches } from '@agoric/store';
import { unsafeMakeBundleCache } from '@agoric/swingset-vat/tools/bundleTool.js';
import {
  ceilMultiplyBy,
  makeRatio,
} from '@agoric/zoe/src/contractSupport/index.js';
import { assertAmountsEqual } from '@agoric/zoe/test/zoeTestHelpers.js';
import { eventLoopIteration } from '@agoric/zoe/tools/eventLoopIteration.js';
import { makeManualPriceAuthority } from '@agoric/zoe/tools/manualPriceAuthority.js';

import buildManualTimer from '@agoric/zoe/tools/manualTimer.js';
import { makeScriptedPriceAuthority } from '@agoric/zoe/tools/scriptedPriceAuthority.js';
import { E } from '@endo/eventual-send';
import { deeplyFulfilled } from '@endo/marshal';
import * as Collect from '../../src/collect.js';
import { calculateCurrentDebt } from '../../src/interest-math.js';
import { SECONDS_PER_YEAR } from '../../src/interest.js';
import {
  setupReserve,
  startAuction,
  startVaultFactory,
} from '../../src/proposals/econ-behaviors.js';
import {
  CHARGING_PERIOD_KEY,
  RECORDING_PERIOD_KEY,
} from '../../src/vaultFactory/params.js';
import '../../src/vaultFactory/types.js';
import { metricsTracker, vaultManagerMetricsTracker } from '../metrics.js';
import {
  installPuppetGovernance,
  produceInstallations,
  setupBootstrap,
  setUpZoeForTest,
  withAmountUtils,
} from '../supports.js';
import { startEconomicCommittee } from '../../src/proposals/startEconCommittee.js';

/** @typedef {Record<string, any> & {
 * aeth: IssuerKit & import('../supports.js').AmountUtils,
 * run: IssuerKit & import('../supports.js').AmountUtils,
 * bundleCache: Awaited<ReturnType<typeof unsafeMakeBundleCache>>,
 * rates: VaultManagerParamValues,
 * loanTiming: LoanTiming,
 * zoe: ZoeService,
 * }} Context */
/** @type {import('ava').TestFn<Context>} */
const test = unknownTest;

const contractRoots = {
  faucet: './test/vaultFactory/faucet.js',
  VaultFactory: './src/vaultFactory/vaultFactory.js',
  reserve: './src/reserve/assetReserve.js',
  auction: './src/auction/auctioneer.js',
};

/** @typedef {import('../../src/vaultFactory/vaultFactory').VaultFactoryContract} VFC */

const trace = makeTracer('TestST', true);

const BASIS_POINTS = 10000n;
const SECONDS_PER_DAY = SECONDS_PER_YEAR / 365n;
const SECONDS_PER_WEEK = SECONDS_PER_DAY * 7n;

// Define locally to test that vaultFactory uses these values
export const Phase = /** @type {const} */ ({
  ACTIVE: 'active',
  LIQUIDATING: 'liquidating',
  CLOSED: 'closed',
  LIQUIDATED: 'liquidated',
  TRANSFER: 'transfer',
});

/**
 * dL: 1M, lM: 105%, lP: 10%, iR: 100, lF: 500
 *
 * @param {Brand<'nat'>} debtBrand
 */
export const defaultParamValues = debtBrand =>
  harden({
    debtLimit: AmountMath.make(debtBrand, 1_000_000n),
    // margin required to maintain a loan
    liquidationMargin: makeRatio(105n, debtBrand),
    // penalty upon liquidation as proportion of debt
    liquidationPenalty: makeRatio(10n, debtBrand),
    // periodic interest rate (per charging period)
    interestRate: makeRatio(100n, debtBrand, BASIS_POINTS),
    // charge to create or increase loan balance
    loanFee: makeRatio(500n, debtBrand, BASIS_POINTS),
    // NB: liquidationPadding defaults to zero in contract
  });

test.before(async t => {
  const { zoe, feeMintAccessP } = await setUpZoeForTest();
  const runIssuer = await E(zoe).getFeeIssuer();
  const runBrand = await E(runIssuer).getBrand();
  // @ts-expect-error missing mint
  const run = withAmountUtils({ issuer: runIssuer, brand: runBrand });
  const aeth = withAmountUtils(makeIssuerKit('aEth'));

  const bundleCache = await unsafeMakeBundleCache('./bundles/'); // package-relative
  // note that the liquidation might be a different bundle name
  const bundles = await Collect.allValues({
    faucet: bundleCache.load(contractRoots.faucet, 'faucet'),
    VaultFactory: bundleCache.load(contractRoots.VaultFactory, 'VaultFactory'),
    auction: bundleCache.load(contractRoots.auction, 'auction'),
    reserve: bundleCache.load(contractRoots.reserve, 'reserve'),
  });
  const installation = objectMap(bundles, bundle => E(zoe).install(bundle));

  const feeMintAccess = await feeMintAccessP;
  const contextPs = {
    zoe,
    feeMintAccess,
    bundles,
    installation,
    electorateTerms: undefined,
    loanTiming: {
      chargingPeriod: 2n,
      recordingPeriod: 6n,
    },
    minInitialDebt: 50n,
    rates: defaultParamValues(run.brand),
  };
  const frozenCtx = await deeplyFulfilled(harden(contextPs));
  t.context = {
    ...frozenCtx,
    bundleCache,
    aeth,
    run,
  };
  trace(t, 'CONTEXT');
});

export const setupElectorateReserveAndAuction = async (
  t,
  run,
  aeth,
  priceOrList,
  quoteInterval,
  unitAmountIn,
  startFrequency = undefined,
) => {
  const {
    zoe,
    electorateTerms = { committeeName: 'The Cabal', committeeSize: 1 },
    timer,
  } = t.context;

  const space = setupBootstrap(t, timer);
  installPuppetGovernance(zoe, space.installation.produce);
  produceInstallations(space, t.context.installation);

  await startEconomicCommittee(space, electorateTerms);
  await setupReserve(space);
  const quoteIssuerKit = makeIssuerKit('quote', AssetKind.SET);

  // Cheesy hack for easy use of manual price authority
  const pa = Array.isArray(priceOrList)
    ? makeScriptedPriceAuthority({
        actualBrandIn: aeth.brand,
        actualBrandOut: run.brand,
        priceList: priceOrList,
        timer,
        quoteMint: quoteIssuerKit.mint,
        unitAmountIn,
        quoteInterval,
      })
    : makeManualPriceAuthority({
        actualBrandIn: aeth.brand,
        actualBrandOut: run.brand,
        initialPrice: priceOrList,
        timer,
        quoteIssuerKit,
      });
  space.produce.priceAuthority.resolve(pa);

  const auctionParams = {
    startFreq: startFrequency || 7n * 24n * 3600n,
    clockStep: 2n,
    startingRate: 10500n,
    lowestRate: 5500n,
    discountStep: 2000n,
    auctionStartDelay: 10n,
    priceLockPeriod: 3n,
  };

  await startAuction(space, { auctionParams });
  return { space };
};

/**
 *
 * @param {import('ava').ExecutionContext<any>} t
 * @param {bigint} amount
 */
export const getRunFromFaucet = async (t, amount) => {
  const {
    installation: { faucet: installation },
    zoe,
    feeMintAccess,
    run,
  } = t.context;
  /** @type {Promise<Installation<import('./faucet.js').start>>} */
  // On-chain, there will be pre-existing RUN. The faucet replicates that
  // @ts-expect-error
  const { creatorFacet: faucetCreator } = await E(zoe).startInstance(
    installation,
    {},
    {},
    harden({ feeMintAccess }),
  );
  const faucetSeat = E(zoe).offer(
    await E(faucetCreator).makeFaucetInvitation(),
    harden({
      give: {},
      want: { RUN: run.make(amount) },
    }),
    harden({}),
  );

  const runPayment = await E(faucetSeat).getPayout('RUN');
  return runPayment;
};

/**
 * Vault offer result used to include `publicNotifiers` but now is `publicSubscribers`.
 *
 * @param {UserSeat<VaultKit>} vaultSeat
 */
export const legacyOfferResult = vaultSeat => {
  return E(vaultSeat)
    .getOfferResult()
    .then(result => {
      const { vault, publicSubscribers } = result;
      assert(vault, 'missing vault');
      assert(publicSubscribers, 'missing publicSubscribers');
      return {
        vault,
        publicNotifiers: {
          vault: makeNotifierFromSubscriber(publicSubscribers.vault.subscriber),
        },
      };
    });
};

/**
 * NOTE: called separately by each test so AMM/zoe/priceAuthority don't interfere
 *
 * @param {import('ava').ExecutionContext<Context>} t
 * @param {Array<NatValue> | Ratio} priceOrList
 * @param {Amount | undefined} unitAmountIn
 * @param {import('@agoric/time/src/types').TimerService} timer
 * @param {RelativeTime} quoteInterval
 * @param {bigint} runInitialLiquidity
 * @param {bigint} [startFrequency]
 */
const setupServices = async (
  t,
  priceOrList,
  unitAmountIn,
  timer = buildManualTimer(t.log, 0n, { eventLoopIteration }),
  quoteInterval = 1n,
  runInitialLiquidity,
  startFrequency = undefined,
) => {
  const { zoe, run, aeth, loanTiming, minInitialDebt, rates } = t.context;
  t.context.timer = timer;

  const runPayment = await getRunFromFaucet(t, runInitialLiquidity);
  trace(t, 'faucet', { runInitialLiquidity, runPayment });

  const { space } = await setupElectorateReserveAndAuction(
    t,
    run,
    aeth,
    priceOrList,
    quoteInterval,
    unitAmountIn,
    // @ts-expect-error override default type
    startFrequency,
  );

  const { consume } = space;

  const {
    installation: { produce: iProduce },
  } = space;
  iProduce.VaultFactory.resolve(t.context.installation.VaultFactory);
  iProduce.liquidate.resolve(t.context.installation.liquidate);
  await startVaultFactory(space, { loanParams: loanTiming }, minInitialDebt);

  const governorCreatorFacet = E.get(
    consume.vaultFactoryKit,
  ).governorCreatorFacet;
  /** @type {Promise<VaultFactoryCreatorFacet & LimitedCreatorFacet<VaultFactoryCreatorFacet>>} */
  const vaultFactoryCreatorFacetP = E.get(consume.vaultFactoryKit).creatorFacet;
  const reserveCreatorFacet = E.get(consume.reserveKit).creatorFacet;
  const reserveKit = { reserveCreatorFacet };

  // Add a vault that will lend on aeth collateral
  /** @type {Promise<VaultManager>} */
  const aethVaultManagerP = E(vaultFactoryCreatorFacetP).addVaultType(
    aeth.issuer,
    'AEth',
    rates,
  );
  /** @type {[any, VaultFactoryCreatorFacet, VFC['publicFacet'], VaultManager, PriceAuthority, CollateralManager]} */
  const [
    governorInstance,
    vaultFactory, // creator
    vfPublic,
    aethVaultManager,
    priceAuthority,
    aethCollateralManager,
  ] = await Promise.all([
    E(consume.agoricNames).lookup('instance', 'VaultFactoryGovernor'),
    vaultFactoryCreatorFacetP,
    E.get(consume.vaultFactoryKit).publicFacet,
    aethVaultManagerP,
    consume.priceAuthority,
    E(aethVaultManagerP).getPublicFacet(),
  ]);
  trace(t, 'pa', {
    governorInstance,
    vaultFactory,
    vfPublic,
    priceAuthority: !!priceAuthority,
  });

  const { g, v } = {
    g: {
      governorInstance,
      governorPublicFacet: E(zoe).getPublicFacet(governorInstance),
      governorCreatorFacet,
    },
    v: {
      vaultFactory,
      vfPublic,
      aethVaultManager,
      aethCollateralManager,
    },
  };

  return {
    zoe,
    governor: g,
    vaultFactory: v,
    runKit: { issuer: run.issuer, brand: run.brand },
    priceAuthority,
    reserveKit,
  };
};

test('first', async t => {
  const { aeth, run, zoe, rates } = t.context;
  t.context.loanTiming = {
    chargingPeriod: 2n,
    recordingPeriod: 10n,
  };

  const services = await setupServices(
    t,
    [500n, 15n],
    aeth.make(900n),
    undefined,
    undefined,
    500n,
  );
  const { vaultFactory, vfPublic } = services.vaultFactory;
  trace(t, 'services', { services, vaultFactory, vfPublic });

  // Create a loan for 470 Minted with 1100 aeth collateral
  const collateralAmount = aeth.make(1100n);
  const loanAmount = run.make(470n);
  /** @type {UserSeat<VaultKit>} */
  const vaultSeat = await E(zoe).offer(
    await E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: collateralAmount },
      want: { Minted: loanAmount },
    }),
    harden({
      Collateral: aeth.mint.mintPayment(collateralAmount),
    }),
  );

  const { vault } = await legacyOfferResult(vaultSeat);
  const debtAmount = await E(vault).getCurrentDebt();
  const fee = ceilMultiplyBy(run.make(470n), rates.loanFee);
  t.deepEqual(
    debtAmount,
    AmountMath.add(loanAmount, fee),
    'vault lent 470 Minted',
  );
  trace(t, 'correct debt', debtAmount);

  const { Minted: lentAmount } = await E(vaultSeat).getFinalAllocation();
  const loanProceeds = await E(vaultSeat).getPayouts();
  const runLent = await loanProceeds.Minted;
  t.deepEqual(lentAmount, loanAmount, 'received 47 Minted');
  t.deepEqual(
    await E(vault).getCollateralAmount(),
    aeth.make(1100n),
    'vault holds 1100 Collateral',
  );

  // Add more collateral to an existing loan. We get nothing back but a warm
  // fuzzy feeling.

  // partially payback
  const collateralWanted = aeth.make(100n);
  const paybackAmount = run.make(200n);
  const [paybackPayment, _remainingPayment] = await E(run.issuer).split(
    runLent,
    paybackAmount,
  );

  const seat = await E(zoe).offer(
    await E(vault).makeAdjustBalancesInvitation(),
    harden({
      give: { Minted: paybackAmount },
      want: { Collateral: collateralWanted },
    }),
    harden({
      Minted: paybackPayment,
    }),
  );

  const payouts = E(seat).getPayouts();
  const { Collateral: returnedCollateral, Minted: returnedRun } = await payouts;
  t.deepEqual(
    await E(vault).getCurrentDebt(),
    run.make(294n),
    'debt reduced to 294 Minted',
  );
  t.deepEqual(
    await E(vault).getCollateralAmount(),
    aeth.make(1000n),
    'vault holds 1000 Collateral',
  );
  t.deepEqual(
    await aeth.issuer.getAmountOf(returnedCollateral),
    aeth.make(100n),
    'withdrew 100 collateral',
  );
  t.deepEqual(
    await E(run.issuer).getAmountOf(returnedRun),
    run.makeEmpty(),
    'received no run',
  );

  t.is((await E(vault).getCurrentDebt()).value, 294n, 'debt is still owed');
  t.deepEqual(
    await E(vault).getCollateralAmount(),
    aeth.make(1000n),
    'unused collateral remains after liquidation',
  );

  t.deepEqual(await E(vaultFactory).getRewardAllocation(), {
    Minted: run.make(24n),
  });
});

test('vaultFactory display collateral', async t => {
  const { aeth, run, rates: defaultRates } = t.context;
  t.context.rates = harden({
    ...defaultRates,
    loanFee: makeRatio(530n, run.brand, BASIS_POINTS),
  });

  const services = await setupServices(
    t,
    [500n, 1500n],
    aeth.make(90n),
    buildManualTimer(t.log),
    undefined,
    500n,
  );

  const { vfPublic } = services.vaultFactory;
  const collaterals = await E(vfPublic).getCollaterals();
  t.deepEqual(collaterals[0], {
    brand: aeth.brand,
    liquidationMargin: makeRatio(105n, run.brand),
    stabilityFee: makeRatio(530n, run.brand, BASIS_POINTS),
    marketPrice: makeRatio(5n, run.brand, 1n, aeth.brand),
    interestRate: makeRatio(100n, run.brand, 10000n, run.brand),
  });
});

test('interest on multiple vaults', async t => {
  const { zoe, aeth, run, rates: defaultRates } = t.context;
  const rates = {
    ...defaultRates,
    interestRate: makeRatio(5n, run.brand),
  };
  t.context.rates = rates;
  // charging period is 1 week. Clock ticks by days
  t.context.loanTiming = {
    chargingPeriod: SECONDS_PER_WEEK,
    recordingPeriod: SECONDS_PER_WEEK,
  };
  const manualTimer = buildManualTimer(t.log, 0n, {
    timeStep: SECONDS_PER_DAY,
    eventLoopIteration,
  });
  const services = await setupServices(
    t,
    [500n, 1500n],
    aeth.make(90n),
    manualTimer,
    SECONDS_PER_DAY,
    500n,
    // manual timer steps with granularity of a day, which confuses the auction
    52n * 7n * 24n * 3600n,
  );
  const { aethCollateralManager, vaultFactory, vfPublic } =
    services.vaultFactory;

  // Create a loan for Alice for 4700 Minted with 1100 aeth collateral
  const collateralAmount = aeth.make(1100n);
  const aliceLoanAmount = run.make(4700n);
  /** @type {UserSeat<VaultKit>} */
  const aliceLoanSeat = await E(zoe).offer(
    E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: collateralAmount },
      want: { Minted: aliceLoanAmount },
    }),
    harden({
      Collateral: aeth.mint.mintPayment(collateralAmount),
    }),
  );
  const {
    vault: aliceVault,
    publicNotifiers: { vault: aliceNotifier },
  } = await legacyOfferResult(aliceLoanSeat);

  const debtAmount = await E(aliceVault).getCurrentDebt();
  const fee = ceilMultiplyBy(aliceLoanAmount, rates.loanFee);
  t.deepEqual(
    debtAmount,
    AmountMath.add(aliceLoanAmount, fee),
    'vault lent 4700 Minted + fees',
  );

  const { Minted: lentAmount } = await E(aliceLoanSeat).getFinalAllocation();
  const loanProceeds = await E(aliceLoanSeat).getPayouts();
  t.deepEqual(lentAmount, aliceLoanAmount, 'received 4700 Minted');

  const runLent = await loanProceeds.Minted;
  t.truthy(
    AmountMath.isEqual(
      await E(run.issuer).getAmountOf(runLent),
      run.make(4700n),
    ),
  );

  // Create a loan for Bob for 3200 Minted with 800 aeth collateral
  const bobCollateralAmount = aeth.make(800n);
  const bobLoanAmount = run.make(3200n);
  /** @type {UserSeat<VaultKit>} */
  const bobLoanSeat = await E(zoe).offer(
    E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: bobCollateralAmount },
      want: { Minted: bobLoanAmount },
    }),
    harden({
      Collateral: aeth.mint.mintPayment(bobCollateralAmount),
    }),
  );
  const {
    vault: bobVault,
    publicNotifiers: { vault: bobNotifier },
  } = await legacyOfferResult(bobLoanSeat);

  const bobDebtAmount = await E(bobVault).getCurrentDebt();
  const bobFee = ceilMultiplyBy(bobLoanAmount, rates.loanFee);
  t.deepEqual(
    bobDebtAmount,
    AmountMath.add(bobLoanAmount, bobFee),
    'vault lent 3200 Minted + fees',
  );

  const { Minted: bobLentAmount } = await E(bobLoanSeat).getFinalAllocation();
  const bobLoanProceeds = await E(bobLoanSeat).getPayouts();
  t.deepEqual(bobLentAmount, bobLoanAmount, 'received 4700 Minted');

  const bobRunLent = await bobLoanProceeds.Minted;
  t.truthy(
    AmountMath.isEqual(
      await E(run.issuer).getAmountOf(bobRunLent),
      run.make(3200n),
    ),
  );

  // { chargingPeriod: weekly, recordingPeriod: weekly }
  // Advance 8 days, past one charging and recording period
  await manualTimer.tickN(8);

  const assetUpdate = (
    await E(E(aethCollateralManager).getSubscriber()).subscribeAfter()
  ).head;

  const aliceUpdate = await E(aliceNotifier).getUpdateSince();
  const bobUpdate = await E(bobNotifier).getUpdateSince();

  // 160n is initial fee. interest is ~3n/week. compounding is in the noise.
  const bobAddedDebt = 160n + 3n;
  t.deepEqual(
    calculateCurrentDebt(
      bobUpdate.value.debtSnapshot.debt,
      bobUpdate.value.debtSnapshot.interest,
      assetUpdate.value.compoundedInterest,
    ),
    run.make(3200n + bobAddedDebt),
  );

  // 236 is the initial fee. Interest is ~4n/week
  const aliceAddedDebt = 236n + 4n;
  t.deepEqual(
    calculateCurrentDebt(
      aliceUpdate.value.debtSnapshot.debt,
      aliceUpdate.value.debtSnapshot.interest,
      assetUpdate.value.compoundedInterest,
    ),
    run.make(4700n + aliceAddedDebt),
    `should have collected ${aliceAddedDebt}`,
  );
  // but no change to the snapshot
  t.deepEqual(aliceUpdate.value.debtSnapshot, {
    debt: run.make(4935n),
    interest: makeRatio(100n, run.brand, 100n),
  });

  const rewardAllocation = await E(vaultFactory).getRewardAllocation();
  const rewardRunCount = aliceAddedDebt + bobAddedDebt;
  t.is(
    rewardAllocation.Minted.value,
    rewardRunCount,
    // reward includes 5% fees on two loans plus 1% interest three times on each
    `Should be ${rewardRunCount}, was ${rewardAllocation.Minted.value}`,
  );

  // try opening a vault that can't cover fees
  /** @type {UserSeat<VaultKit>} */
  const caroleLoanSeat = await E(zoe).offer(
    E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: aeth.make(200n) },
      want: { Minted: run.make(0n) }, // no debt
    }),
    harden({
      Collateral: aeth.mint.mintPayment(aeth.make(200n)),
    }),
  );
  await t.throwsAsync(E(caroleLoanSeat).getOfferResult());

  // Advance another 7 days, past one charging and recording period
  await manualTimer.tickN(8);

  // open a vault when manager's interest already compounded
  const wantedRun = 1_000n;
  /** @type {UserSeat<VaultKit>} */
  const danLoanSeat = await E(zoe).offer(
    E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: aeth.make(2_000n) },
      want: { Minted: run.make(wantedRun) },
    }),
    harden({
      Collateral: aeth.mint.mintPayment(aeth.make(2_000n)),
    }),
  );
  const {
    vault: danVault,
    publicNotifiers: { vault: danNotifier },
  } = await legacyOfferResult(danLoanSeat);
  const danActualDebt = wantedRun + 50n; // includes fees
  t.is((await E(danVault).getCurrentDebt()).value, danActualDebt);
  const normalizedDebt = (await E(danVault).getNormalizedDebt()).value;
  t.true(
    normalizedDebt < danActualDebt,
    `Normalized debt ${normalizedDebt} must be less than actual ${danActualDebt} (after any time elapsed)`,
  );
  t.is((await E(danVault).getNormalizedDebt()).value, 1_048n);
  const danUpdate = await E(danNotifier).getUpdateSince();
  // snapshot should equal actual since no additional time has elapsed
  const { debtSnapshot: danSnap } = danUpdate.value;
  t.is(danSnap.debt.value, danActualDebt);
});

test('adjust balances', async t => {
  const { zoe, aeth, run, rates } = t.context;
  t.context;

  const services = await setupServices(
    t,
    [15n],
    aeth.make(1n),
    buildManualTimer(t.log),
    undefined,
    500n,
  );
  const { vfPublic } = services.vaultFactory;

  // initial loan /////////////////////////////////////

  // Create a loan for Alice for 5000 Minted with 1000 aeth collateral
  const collateralAmount = aeth.make(1000n);
  const aliceLoanAmount = run.make(5000n);
  /** @type {UserSeat<VaultKit>} */
  const aliceLoanSeat = await E(zoe).offer(
    E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: collateralAmount },
      want: { Minted: aliceLoanAmount },
    }),
    harden({
      Collateral: aeth.mint.mintPayment(collateralAmount),
    }),
  );
  const {
    vault: aliceVault,
    publicNotifiers: { vault: aliceNotifier },
  } = await legacyOfferResult(aliceLoanSeat);

  let debtAmount = await E(aliceVault).getCurrentDebt();
  const fee = ceilMultiplyBy(aliceLoanAmount, rates.loanFee);
  let runDebtLevel = AmountMath.add(aliceLoanAmount, fee);
  let collateralLevel = aeth.make(1000n);

  t.deepEqual(debtAmount, runDebtLevel, 'vault lent 5000 Minted + fees');
  const { Minted: lentAmount } = await E(aliceLoanSeat).getFinalAllocation();
  const loanProceeds = await E(aliceLoanSeat).getPayouts();
  t.deepEqual(lentAmount, aliceLoanAmount, 'received 5000 Minted');

  const runLent = await loanProceeds.Minted;
  t.truthy(
    AmountMath.isEqual(
      await E(run.issuer).getAmountOf(runLent),
      run.make(5000n),
    ),
  );

  let aliceUpdate = await E(aliceNotifier).getUpdateSince();
  t.deepEqual(aliceUpdate.value.debtSnapshot.debt, runDebtLevel);
  t.deepEqual(aliceUpdate.value.debtSnapshot, {
    debt: run.make(5250n),
    interest: makeRatio(100n, run.brand),
  });

  // increase collateral 1 ///////////////////////////////////// (give both)

  // Alice increase collateral by 100, paying in 50 Minted against debt
  const collateralIncrement = aeth.make(100n);
  const depositRunAmount = run.make(50n);
  runDebtLevel = AmountMath.subtract(runDebtLevel, depositRunAmount);
  collateralLevel = AmountMath.add(collateralLevel, collateralIncrement);

  const [paybackPayment, _remainingPayment] = await E(run.issuer).split(
    runLent,
    depositRunAmount,
  );

  const aliceAddCollateralSeat1 = await E(zoe).offer(
    E(aliceVault).makeAdjustBalancesInvitation(),
    harden({
      give: { Collateral: collateralIncrement, Minted: depositRunAmount },
    }),
    harden({
      Collateral: aeth.mint.mintPayment(collateralIncrement),
      Minted: paybackPayment,
    }),
  );

  await E(aliceAddCollateralSeat1).getOfferResult();
  debtAmount = await E(aliceVault).getCurrentDebt();
  t.deepEqual(debtAmount, runDebtLevel);

  const { Minted: lentAmount2 } = await E(
    aliceAddCollateralSeat1,
  ).getFinalAllocation();
  const loanProceeds2 = await E(aliceAddCollateralSeat1).getPayouts();
  t.deepEqual(lentAmount2, run.makeEmpty(), 'no payout');

  const runLent2 = await loanProceeds2.Minted;
  t.truthy(
    AmountMath.isEqual(
      await E(run.issuer).getAmountOf(runLent2),
      run.makeEmpty(),
    ),
  );

  aliceUpdate = await E(aliceNotifier).getUpdateSince();
  t.deepEqual(aliceUpdate.value.debtSnapshot.debt, runDebtLevel);

  // increase collateral 2 ////////////////////////////////// (want:s, give:c)

  // Alice increase collateral by 100, withdrawing 50 Minted
  const collateralIncrement2 = aeth.make(100n);
  const withdrawRunAmount = run.make(50n);
  const withdrawRunAmountWithFees = ceilMultiplyBy(
    withdrawRunAmount,
    rates.loanFee,
  );
  runDebtLevel = AmountMath.add(
    runDebtLevel,
    AmountMath.add(withdrawRunAmount, withdrawRunAmountWithFees),
  );
  collateralLevel = AmountMath.add(collateralLevel, collateralIncrement2);

  const aliceAddCollateralSeat2 = await E(zoe).offer(
    E(aliceVault).makeAdjustBalancesInvitation(),
    harden({
      give: { Collateral: collateralIncrement2 },
      want: { Minted: withdrawRunAmount },
    }),
    harden({
      Collateral: aeth.mint.mintPayment(collateralIncrement2),
    }),
  );

  await E(aliceAddCollateralSeat2).getOfferResult();
  const { Minted: lentAmount3 } = await E(
    aliceAddCollateralSeat2,
  ).getFinalAllocation();
  const loanProceeds3 = await E(aliceAddCollateralSeat2).getPayouts();
  t.deepEqual(lentAmount3, run.make(50n));

  debtAmount = await E(aliceVault).getCurrentDebt();
  t.deepEqual(debtAmount, runDebtLevel);

  const runLent3 = await loanProceeds3.Minted;
  t.truthy(
    AmountMath.isEqual(
      await E(run.issuer).getAmountOf(runLent3),
      run.make(50n),
    ),
  );

  aliceUpdate = await E(aliceNotifier).getUpdateSince();
  t.deepEqual(aliceUpdate.value.debtSnapshot.debt, runDebtLevel);
  t.deepEqual(aliceUpdate.value.debtSnapshot, {
    debt: run.make(5253n),
    interest: run.makeRatio(100n),
  });

  // reduce collateral  ///////////////////////////////////// (want both)

  // Alice reduce collateral by 100, withdrawing 50 Minted
  const collateralDecrement = aeth.make(100n);
  const withdrawRun2 = run.make(50n);
  const withdrawRun2WithFees = ceilMultiplyBy(withdrawRun2, rates.loanFee);
  runDebtLevel = AmountMath.add(
    runDebtLevel,
    AmountMath.add(withdrawRunAmount, withdrawRun2WithFees),
  );
  collateralLevel = AmountMath.subtract(collateralLevel, collateralDecrement);
  const aliceReduceCollateralSeat = await E(zoe).offer(
    E(aliceVault).makeAdjustBalancesInvitation(),
    harden({
      want: { Minted: withdrawRun2, Collateral: collateralDecrement },
    }),
    harden({}),
  );

  await E(aliceReduceCollateralSeat).getOfferResult();

  debtAmount = await E(aliceVault).getCurrentDebt();
  t.deepEqual(debtAmount, runDebtLevel);
  t.deepEqual(collateralLevel, await E(aliceVault).getCollateralAmount());

  const { Minted: lentAmount4 } = await E(
    aliceReduceCollateralSeat,
  ).getFinalAllocation();
  const loanProceeds4 = await E(aliceReduceCollateralSeat).getPayouts();
  t.deepEqual(lentAmount4, run.make(50n));

  const runBorrowed = await loanProceeds4.Minted;
  t.truthy(
    AmountMath.isEqual(
      await E(run.issuer).getAmountOf(runBorrowed),
      run.make(50n),
    ),
  );
  const collateralWithdrawn = await loanProceeds4.Collateral;
  t.truthy(
    AmountMath.isEqual(
      await E(aeth.issuer).getAmountOf(collateralWithdrawn),
      collateralDecrement,
    ),
  );

  aliceUpdate = await E(aliceNotifier).getUpdateSince();
  t.deepEqual(aliceUpdate.value.debtSnapshot.debt, runDebtLevel);

  // NSF  ///////////////////////////////////// (want too much of both)

  // Alice reduce collateral by 100, withdrawing 50 Minted
  const collateralDecr2 = aeth.make(800n);
  const withdrawRun3 = run.make(500n);
  const withdrawRun3WithFees = ceilMultiplyBy(withdrawRun3, rates.loanFee);
  runDebtLevel = AmountMath.add(
    runDebtLevel,
    AmountMath.add(withdrawRunAmount, withdrawRun3WithFees),
  );
  const aliceReduceCollateralSeat2 = await E(zoe).offer(
    E(aliceVault).makeAdjustBalancesInvitation(),
    harden({
      want: { Minted: withdrawRun3, Collateral: collateralDecr2 },
    }),
  );

  await t.throwsAsync(() => E(aliceReduceCollateralSeat2).getOfferResult(), {
    // Double-disclosure bug endojs/endo#640
    // wildcards were:
    // "brand":"[Alleged: IST brand]","value":"[5829n]"
    // "value":"[3750n]","brand":"[Alleged: IST brand]"
    message: / is more than the collateralization ratio allows:/,
    // message: /The requested debt {.*} is more than the collateralization ratio allows: {.*}/,
  });

  // try to trade zero for zero
  const aliceReduceCollateralSeat3 = await E(zoe).offer(
    E(aliceVault).makeAdjustBalancesInvitation(),
    harden({
      want: {
        Minted: run.makeEmpty(),
        Collateral: aeth.makeEmpty(),
      },
    }),
  );

  t.is(
    await E(aliceReduceCollateralSeat3).getOfferResult(),
    'no transaction, as requested',
  );
});

test('adjust balances - withdraw RUN', async t => {
  const { zoe, aeth, run, rates } = t.context;
  t.context;

  const services = await setupServices(
    t,
    [15n],
    aeth.make(1n),
    buildManualTimer(t.log),
    undefined,
    500n,
  );
  const { vfPublic } = services.vaultFactory;

  // initial loan /////////////////////////////////////

  // Create a loan for Alice for 5000 RUN with 1000 aeth collateral
  const collateralAmount = aeth.make(1000n);
  const aliceLoanAmount = run.make(5000n);
  /** @type {UserSeat<VaultKit>} */
  const aliceLoanSeat = await E(zoe).offer(
    E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: collateralAmount },
      want: { Minted: aliceLoanAmount },
    }),
    harden({
      Collateral: aeth.mint.mintPayment(collateralAmount),
    }),
  );
  const {
    vault: aliceVault,
    publicNotifiers: { vault: aliceNotifier },
  } = await legacyOfferResult(aliceLoanSeat);

  let debtAmount = await E(aliceVault).getCurrentDebt();
  const fee = ceilMultiplyBy(aliceLoanAmount, rates.loanFee);
  let runDebtLevel = AmountMath.add(aliceLoanAmount, fee);

  // Withdraw add'l RUN /////////////////////////////////////
  // Alice deposits nothing; requests more RUN

  const additionalRUN = run.make(100n);
  const aliceWithdrawRunSeat = await E(zoe).offer(
    E(aliceVault).makeAdjustBalancesInvitation(),
    harden({
      want: { Minted: additionalRUN },
    }),
  );

  await E(aliceWithdrawRunSeat).getOfferResult();
  debtAmount = await E(aliceVault).getCurrentDebt();
  runDebtLevel = AmountMath.add(
    runDebtLevel,
    AmountMath.add(additionalRUN, run.make(5n)),
  );
  t.deepEqual(debtAmount, runDebtLevel);

  const { Minted: lentAmount2 } = await E(
    aliceWithdrawRunSeat,
  ).getFinalAllocation();
  const loanProceeds2 = await E(aliceWithdrawRunSeat).getPayouts();
  t.deepEqual(lentAmount2, additionalRUN, '100 RUN');

  const { Minted: runLent2 } = await loanProceeds2;
  t.deepEqual(await E(run.issuer).getAmountOf(runLent2), additionalRUN);

  const aliceUpdate = await E(aliceNotifier).getUpdateSince();
  t.deepEqual(aliceUpdate.value.debtSnapshot.debt, runDebtLevel);
});

test('adjust balances after interest charges', async t => {
  const LOAN1 = 450n;
  const AMPLE = 100_000n;
  const { aeth, run } = t.context;

  // charge interest on every tick
  const manualTimer = buildManualTimer(trace, 0n, {
    timeStep: SECONDS_PER_DAY,
  });
  t.context.loanTiming = {
    chargingPeriod: SECONDS_PER_DAY,
    recordingPeriod: SECONDS_PER_DAY,
  };
  t.context.rates = {
    ...t.context.rates,
    interestRate: run.makeRatio(20n),
  };

  const services = await setupServices(
    t,
    makeRatio(1n, run.brand, 100n, aeth.brand),
    undefined,
    manualTimer,
    undefined, // n/a, manual price authority
    10_000n,
  );

  const { vfPublic } = services.vaultFactory;

  trace('0. Take out loan');
  const vaultSeat = await E(services.zoe).offer(
    await E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: aeth.make(AMPLE) },
      want: { Minted: run.make(LOAN1) },
    }),
    harden({
      Collateral: t.context.aeth.mint.mintPayment(aeth.make(AMPLE)),
    }),
  );
  const { vault } = await E(vaultSeat).getOfferResult();

  trace('1. Charge interest');
  await manualTimer.tick();
  await manualTimer.tick();

  trace('2. Pay down');
  const adjustBalances1 = await E(vault).makeAdjustBalancesInvitation();
  const given = run.make(60n);
  const takeCollateralSeat = await E(services.zoe).offer(
    adjustBalances1,
    harden({
      give: { Minted: given },
      want: {},
    }),
    harden({
      Minted: await getRunFromFaucet(t, 60n),
    }),
  );
  const result = await E(takeCollateralSeat).getOfferResult();
  t.is(result, 'We have adjusted your balances, thank you for your business');
});

test('transfer vault', async t => {
  const { aeth, zoe, run } = t.context;

  const services = await setupServices(
    t,
    [15n],
    aeth.make(1n),
    buildManualTimer(t.log),
    undefined,
    500n,
  );
  const { vfPublic } = services.vaultFactory;

  // initial loan /////////////////////////////////////

  // Create a loan for Alice for 5000 Minted with 1000 aeth collateral
  const collateralAmount = aeth.make(1000n);
  const aliceLoanAmount = run.make(5000n);
  /** @type {UserSeat<VaultKit>} */
  const aliceLoanSeat = await E(zoe).offer(
    E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: collateralAmount },
      want: { Minted: aliceLoanAmount },
    }),
    harden({
      Collateral: aeth.mint.mintPayment(collateralAmount),
    }),
  );
  const {
    vault: aliceVault,
    publicNotifiers: { vault: aliceNotifier },
  } = await legacyOfferResult(aliceLoanSeat);

  const debtAmount = await E(aliceVault).getCurrentDebt();

  const getInvitationProperties = async invitation => {
    const invitationIssuer = E(zoe).getInvitationIssuer();
    const amount = await E(invitationIssuer).getAmountOf(invitation);
    return amount.value[0];
  };

  /** @type {Promise<Invitation<VaultKit>>} */
  const transferInvite = E(aliceVault).makeTransferInvitation();
  const inviteProps = await getInvitationProperties(transferInvite);
  trace(t, 'TRANSFER INVITE', transferInvite, inviteProps);
  const transferSeat = await E(zoe).offer(transferInvite);
  const {
    vault: transferVault,
    publicNotifiers: { vault: transferNotifier },
  } = await legacyOfferResult(transferSeat);
  await t.throwsAsync(() => E(aliceVault).getCurrentDebt());
  const debtAfter = await E(transferVault).getCurrentDebt();
  t.deepEqual(debtAfter, debtAmount, 'vault lent 5000 Minted + fees');
  const collateralAfter = await E(transferVault).getCollateralAmount();
  t.deepEqual(collateralAmount, collateralAfter, 'vault has 1000n aEth');

  const aliceFinish = await E(aliceNotifier).getUpdateSince();
  t.deepEqual(
    aliceFinish.value.vaultState,
    Phase.TRANSFER,
    'transfer closed old notifier',
  );

  t.like(inviteProps, {
    debtSnapshot: {
      debt: debtAmount,
      interest: aliceFinish.value.debtSnapshot.interest,
    },
    description: 'TransferVault',
    locked: collateralAmount,
    vaultState: 'active',
  });

  const transferStatus = await E(transferNotifier).getUpdateSince();
  t.deepEqual(
    transferStatus.value.vaultState,
    Phase.ACTIVE,
    'new notifier is active',
  );

  // Interleave with `adjustVault`
  // make the invitation first so that we can arrange the interleaving
  // of adjust and tranfer
  const adjustInvitation = E(transferVault).makeAdjustBalancesInvitation();
  const { Minted: lentAmount } = await E(aliceLoanSeat).getFinalAllocation();
  const aliceProceeds = await E(aliceLoanSeat).getPayouts();
  t.deepEqual(lentAmount, aliceLoanAmount, 'received 5000 Minted');
  const borrowedRun = await aliceProceeds.Minted;
  const payoffRun2 = run.make(600n);
  const [paybackPayment, _remainingPayment] = await E(run.issuer).split(
    borrowedRun,
    payoffRun2,
  );

  // Adjust is multi-turn. Confirm that an interleaved transfer prevents it
  const adjustSeatPromise = E(zoe).offer(
    adjustInvitation,
    harden({
      give: { Minted: payoffRun2 },
      // it's only multi-turn if there is a want
      want: { Collateral: aeth.make(1n) },
    }),
    harden({ Minted: paybackPayment }),
  );
  /** @type {Invitation<VaultKit>} */
  const t2Invite = await E(transferVault).makeTransferInvitation();
  const t2Seat = await E(zoe).offer(t2Invite);
  const {
    vault: t2Vault,
    publicNotifiers: { vault: t2Notifier },
  } = await legacyOfferResult(t2Seat);
  await t.throwsAsync(
    () => E(adjustSeatPromise).getOfferResult(),
    {
      message: 'Transfer during vault adjustment',
    },
    'adjust balances should have been rejected',
  );
  await t.throwsAsync(() => E(transferVault).getCurrentDebt());
  const debtAfter2 = await E(t2Vault).getCurrentDebt();
  t.deepEqual(debtAmount, debtAfter2, 'vault lent 5000 Minted + fees');

  const collateralAfter2 = await E(t2Vault).getCollateralAmount();
  t.deepEqual(collateralAmount, collateralAfter2, 'vault has 1000n aEth');

  const transferFinish = await E(transferNotifier).getUpdateSince();
  t.deepEqual(
    transferFinish.value.vaultState,
    Phase.TRANSFER,
    't2 closed old notifier',
  );

  const t2Status = await E(t2Notifier).getUpdateSince();
  t.deepEqual(
    t2Status.value.vaultState,
    Phase.ACTIVE,
    'new notifier is active',
  );
});

// Alice will over repay her borrowed Minted. In order to make that possible,
// Bob will also take out a loan and will give her the proceeds.
test('overdeposit', async t => {
  const { aeth, zoe, run, rates } = t.context;

  const services = await setupServices(
    t,
    [15n],
    aeth.make(1n),
    buildManualTimer(t.log),
    undefined,
    500n,
  );
  const { vaultFactory, vfPublic } = services.vaultFactory;

  // Alice's loan /////////////////////////////////////

  // Create a loan for Alice for 5000 Minted with 1000 aeth collateral
  const collateralAmount = aeth.make(1000n);
  const aliceLoanAmount = run.make(5000n);
  /** @type {UserSeat<VaultKit>} */
  const aliceLoanSeat = await E(zoe).offer(
    E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: collateralAmount },
      want: { Minted: aliceLoanAmount },
    }),
    harden({
      Collateral: aeth.mint.mintPayment(collateralAmount),
    }),
  );
  const {
    vault: aliceVault,
    publicNotifiers: { vault: aliceNotifier },
  } = await legacyOfferResult(aliceLoanSeat);

  let debtAmount = await E(aliceVault).getCurrentDebt();
  const fee = ceilMultiplyBy(aliceLoanAmount, rates.loanFee);
  const runDebt = AmountMath.add(aliceLoanAmount, fee);

  t.deepEqual(debtAmount, runDebt, 'vault lent 5000 Minted + fees');
  const { Minted: lentAmount } = await E(aliceLoanSeat).getFinalAllocation();
  const aliceProceeds = await E(aliceLoanSeat).getPayouts();
  t.deepEqual(lentAmount, aliceLoanAmount, 'received 5000 Minted');

  const borrowedRun = await aliceProceeds.Minted;
  t.truthy(
    AmountMath.isEqual(
      await E(run.issuer).getAmountOf(borrowedRun),
      run.make(5000n),
    ),
  );

  let aliceUpdate = await E(aliceNotifier).getUpdateSince();
  t.deepEqual(aliceUpdate.value.debtSnapshot.debt, runDebt);
  t.deepEqual(aliceUpdate.value.locked, collateralAmount);

  // Bob's loan /////////////////////////////////////

  // Create a loan for Bob for 1000 Minted with 200 aeth collateral
  const bobCollateralAmount = aeth.make(200n);
  const bobLoanAmount = run.make(1000n);
  /** @type {UserSeat<VaultKit>} */
  const bobLoanSeat = await E(zoe).offer(
    E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: bobCollateralAmount },
      want: { Minted: bobLoanAmount },
    }),
    harden({
      Collateral: aeth.mint.mintPayment(bobCollateralAmount),
    }),
  );
  const bobProceeds = await E(bobLoanSeat).getPayouts();
  await E(bobLoanSeat).getOfferResult();
  const bobRun = await bobProceeds.Minted;
  t.truthy(
    AmountMath.isEqual(
      await E(run.issuer).getAmountOf(bobRun),
      run.make(1000n),
    ),
  );

  // overpay debt ///////////////////////////////////// (give Minted)

  const combinedRun = await E(run.issuer).combine(
    harden([borrowedRun, bobRun]),
  );
  const depositRun2 = run.make(6000n);

  const aliceOverpaySeat = await E(zoe).offer(
    E(aliceVault).makeAdjustBalancesInvitation(),
    harden({
      give: { Minted: depositRun2 },
    }),
    harden({ Minted: combinedRun }),
  );

  await E(aliceOverpaySeat).getOfferResult();
  debtAmount = await E(aliceVault).getCurrentDebt();
  t.deepEqual(debtAmount, run.makeEmpty());

  const { Minted: lentAmount5 } = await E(
    aliceOverpaySeat,
  ).getFinalAllocation();
  const loanProceeds5 = await E(aliceOverpaySeat).getPayouts();
  t.deepEqual(lentAmount5, run.make(750n));

  const runReturned = await loanProceeds5.Minted;
  t.deepEqual(await E(run.issuer).getAmountOf(runReturned), run.make(750n));

  aliceUpdate = await E(aliceNotifier).getUpdateSince();
  t.deepEqual(aliceUpdate.value.debtSnapshot.debt, run.makeEmpty());

  const collectFeesSeat = await E(zoe).offer(
    E(vaultFactory).makeCollectFeesInvitation(),
  );
  await E(collectFeesSeat).getOfferResult();
  assertAmountsEqual(
    t,
    await E.get(E(collectFeesSeat).getFinalAllocation()).Fee,
    run.make(300n),
  );
});

test('bad chargingPeriod', async t => {
  t.throws(
    () =>
      makeParamManagerBuilder(makeStoredPublisherKit())
        // @ts-expect-error bad value for test
        .addNat(CHARGING_PERIOD_KEY, 2)
        .addNat(RECORDING_PERIOD_KEY, 10n)
        .build(),
    { message: '2 must be a bigint' },
  );
});

test('collect fees from loan', async t => {
  const { zoe, aeth, run, rates } = t.context;

  const priceList = [500n, 15n];
  const unitAmountIn = aeth.make(900n);
  const manualTimer = buildManualTimer(t.log);

  // Add a pool with 900 aeth collateral at a 201 aeth/Minted rate

  const services = await setupServices(
    t,
    priceList,
    unitAmountIn,
    manualTimer,
    undefined,
    500n,
  );
  const { vaultFactory, vfPublic } = services.vaultFactory;

  // Create a loan for 470 Minted with 1100 aeth collateral
  const collateralAmount = aeth.make(1100n);
  const loanAmount = run.make(470n);
  /** @type {UserSeat<VaultKit>} */
  const vaultSeat = await E(zoe).offer(
    E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: collateralAmount },
      want: { Minted: loanAmount },
    }),
    harden({
      Collateral: aeth.mint.mintPayment(collateralAmount),
    }),
  );

  const { vault } = await E(vaultSeat).getOfferResult();
  const debtAmount = await E(vault).getCurrentDebt();
  const fee = ceilMultiplyBy(run.make(470n), rates.loanFee);
  t.deepEqual(
    debtAmount,
    AmountMath.add(loanAmount, fee),
    'vault loaned Minted',
  );
  trace(t, 'correct debt', debtAmount);

  const { Minted: lentAmount } = await E(vaultSeat).getFinalAllocation();
  const loanProceeds = await E(vaultSeat).getPayouts();
  await loanProceeds.Minted;
  t.deepEqual(lentAmount, loanAmount, 'received 47 Minted');
  t.deepEqual(
    await E(vault).getCollateralAmount(),
    aeth.make(1100n),
    'vault holds 1100 Collateral',
  );

  const feesCollected = run.make(24n);
  t.deepEqual(await E(vaultFactory).getRewardAllocation(), {
    Minted: feesCollected,
  });

  const collectFeesSeat = await E(zoe).offer(
    E(vaultFactory).makeCollectFeesInvitation(),
  );
  await E(collectFeesSeat).getOfferResult();
  const feePayoutAmount = await E.get(E(collectFeesSeat).getFinalAllocation())
    .Fee;
  trace(t, 'Fee', feesCollected, feePayoutAmount);
  t.truthy(AmountMath.isGTE(feePayoutAmount, feesCollected));
});

test('close loan', async t => {
  const { zoe, aeth, run, rates } = t.context;

  const services = await setupServices(
    t,
    [15n],
    aeth.make(1n),
    buildManualTimer(t.log, 0n, { eventLoopIteration }),
    undefined,
    500n,
  );

  const { vfPublic } = services.vaultFactory;

  // initial loan /////////////////////////////////////

  // Create a loan for Alice for 5000 Minted with 1000 aeth collateral
  const collateralAmount = aeth.make(1000n);
  const aliceLoanAmount = run.make(5000n);
  /** @type {UserSeat<VaultKit>} */
  const aliceLoanSeat = await E(zoe).offer(
    E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: collateralAmount },
      want: { Minted: aliceLoanAmount },
    }),
    harden({
      Collateral: aeth.mint.mintPayment(collateralAmount),
    }),
  );
  const {
    vault: aliceVault,
    publicNotifiers: { vault: aliceNotifier },
  } = await legacyOfferResult(aliceLoanSeat);

  const debtAmount = await E(aliceVault).getCurrentDebt();
  const fee = ceilMultiplyBy(aliceLoanAmount, rates.loanFee);
  const runDebtLevel = AmountMath.add(aliceLoanAmount, fee);

  t.deepEqual(debtAmount, runDebtLevel, 'vault lent 5000 Minted + fees');
  const { Minted: lentAmount } = await E(aliceLoanSeat).getFinalAllocation();
  const loanProceeds = await E(aliceLoanSeat).getPayouts();
  t.deepEqual(lentAmount, aliceLoanAmount, 'received 5000 Minted');

  const runLent = await loanProceeds.Minted;
  t.truthy(
    AmountMath.isEqual(
      await E(run.issuer).getAmountOf(runLent),
      run.make(5000n),
    ),
  );

  const aliceUpdate = await E(aliceNotifier).getUpdateSince();
  t.deepEqual(aliceUpdate.value.debtSnapshot.debt, runDebtLevel);
  t.deepEqual(aliceUpdate.value.locked, collateralAmount);

  // Create a loan for Bob for 1000 Minted with 200 aeth collateral
  const bobCollateralAmount = aeth.make(200n);
  const bobLoanAmount = run.make(1000n);
  /** @type {UserSeat<VaultKit>} */
  const bobLoanSeat = await E(zoe).offer(
    E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: bobCollateralAmount },
      want: { Minted: bobLoanAmount },
    }),
    harden({
      Collateral: aeth.mint.mintPayment(bobCollateralAmount),
    }),
  );
  const bobProceeds = await E(bobLoanSeat).getPayouts();
  await E(bobLoanSeat).getOfferResult();
  const bobRun = await bobProceeds.Minted;
  t.truthy(
    AmountMath.isEqual(
      await E(run.issuer).getAmountOf(bobRun),
      run.make(1000n),
    ),
  );

  // close loan, using Bob's Minted /////////////////////////////////////

  const runRepayment = await E(run.issuer).combine(harden([bobRun, runLent]));

  /** @type {UserSeat<string>} */
  const aliceCloseSeat = await E(zoe).offer(
    E(aliceVault).makeCloseInvitation(),
    harden({
      give: { Minted: run.make(6000n) },
      want: { Collateral: aeth.makeEmpty() },
    }),
    harden({ Minted: runRepayment }),
  );

  const closeOfferResult = await E(aliceCloseSeat).getOfferResult();
  t.is(closeOfferResult, 'your loan is closed, thank you for your business');

  const closeAlloc = await E(aliceCloseSeat).getFinalAllocation();
  t.deepEqual(closeAlloc, {
    Minted: run.make(750n),
    Collateral: aeth.make(1000n),
  });
  const closeProceeds = await E(aliceCloseSeat).getPayouts();
  const collProceeds = await aeth.issuer.getAmountOf(closeProceeds.Collateral);
  const runProceeds = await E(run.issuer).getAmountOf(closeProceeds.Minted);

  t.deepEqual(runProceeds, run.make(750n));
  t.deepEqual(collProceeds, aeth.make(1000n));
  t.deepEqual(await E(aliceVault).getCollateralAmount(), aeth.makeEmpty());
});

test('loan too small - MinInitialDebt', async t => {
  const { zoe, aeth, run } = t.context;
  t.context.minInitialDebt = 50_000n;

  const services = await setupServices(
    t,
    [15n],
    aeth.make(1n),
    buildManualTimer(t.log),
    undefined,
    500n,
  );
  const { vfPublic } = services.vaultFactory;

  // Try to Create a loan for Alice for 5000 Minted with 100 aeth collateral
  const collateralAmount = aeth.make(100n);
  const aliceLoanAmount = run.make(5000n);
  /** @type {UserSeat<VaultKit>} */
  const aliceLoanSeat = await E(zoe).offer(
    E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: collateralAmount },
      want: { Minted: aliceLoanAmount },
    }),
    harden({
      Collateral: aeth.mint.mintPayment(collateralAmount),
    }),
  );
  await t.throwsAsync(() => E(aliceLoanSeat).getOfferResult(), {
    message:
      /The request must be for at least ".50000n.". ".5000n." is too small/,
  });
});

/**
 * Each vaultManager manages one collateral type and has a governed parameter, `debtLimit`,
 * that specifies a cap on the amount of debt the manager will allow.
 *
 * Attempts to adjust balances on vaults beyond the debt limit fail.
 * In other words, minting for anything other than charging interest fails.
 */
test('excessive debt on collateral type - debtLimit', async t => {
  const { zoe, aeth, run } = t.context;

  const services = await setupServices(
    t,
    [15n],
    aeth.make(1n),
    buildManualTimer(t.log),
    undefined,
    500n,
  );
  const { vfPublic } = services.vaultFactory;
  const collateralAmount = aeth.make(1_000_000n);
  const centralAmount = run.make(1_000_000n);
  const loanSeat = await E(zoe).offer(
    E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: collateralAmount },
      want: { Minted: centralAmount },
    }),
    harden({
      Collateral: aeth.mint.mintPayment(collateralAmount),
    }),
  );
  await t.throwsAsync(() => E(loanSeat).getOfferResult(), {
    message:
      'Minting {"brand":"[Alleged: IST brand]","value":"[1050000n]"} past {"brand":"[Alleged: IST brand]","value":"[0n]"} would hit total debt limit {"brand":"[Alleged: IST brand]","value":"[1000000n]"}',
  });
});

test('addVaultType: invalid args do not modify state', async t => {
  const { aeth } = t.context;
  const kw = 'Chit';
  const chit = makeIssuerKit(kw);
  const params = defaultParamValues(chit.brand);

  const services = await setupServices(
    t,
    [500n, 15n],
    aeth.make(900n),
    undefined,
    undefined,
    500n,
  );

  const { vaultFactory } = services.vaultFactory;

  const failsForSameReason = async p =>
    p
      .then(oops => t.fail(`${oops}`))
      .catch(reason1 => t.throwsAsync(p, { message: reason1.message }));
  await failsForSameReason(
    E(vaultFactory)
      // @ts-expect-error bad args on purpose for test
      .addVaultType(chit.issuer, kw, null),
  );
  await failsForSameReason(
    E(vaultFactory).addVaultType(chit.issuer, 'bogus kw', params),
  );

  // The keyword in the vault manager is not "stuck"; it's still available:
  const actual = await E(vaultFactory).addVaultType(chit.issuer, kw, params);
  t.true(matches(actual, M.remotable()));
});

test('addVaultType: extra, unexpected params', async t => {
  const { aeth } = t.context;
  const chit = makeIssuerKit('chit');

  const services = await setupServices(
    t,
    [500n, 15n],
    aeth.make(900n),
    undefined,
    undefined,
    500n,
  );

  const { vaultFactory } = services.vaultFactory;

  const params = { ...defaultParamValues(aeth.brand), shoeSize: 10 };
  const extraParams = { ...params, shoeSize: 10 };
  const { interestRate: _1, ...missingParams } = {
    ...defaultParamValues(aeth.brand),
    shoeSize: 10,
  };

  await t.throwsAsync(
    // @ts-expect-error bad args
    E(vaultFactory).addVaultType(chit.issuer, 'Chit', missingParams),
    {
      message:
        /initialParamValues: .* - Must have missing properties \["interestRate"\]/,
    },
  );

  const actual = await E(vaultFactory).addVaultType(
    chit.issuer,
    'Chit',
    extraParams,
  );
  t.true(matches(actual, M.remotable()), 'unexpected params are ignored');
});

test('director notifiers', async t => {
  const { aeth } = t.context;
  const services = await setupServices(
    t,
    [500n, 15n],
    aeth.make(900n),
    undefined,
    undefined,
    500n,
  );

  const { vfPublic, vaultFactory } = services.vaultFactory;

  const m = await metricsTracker(t, vfPublic);

  await m.assertInitial({
    collaterals: [aeth.brand],
    rewardPoolAllocation: {},
  });

  // add a vault type
  const chit = makeIssuerKit('chit');
  await E(vaultFactory).addVaultType(
    chit.issuer,
    'Chit',
    defaultParamValues(chit.brand),
  );
  await m.assertChange({
    collaterals: { 1: chit.brand },
  });

  // Not testing rewardPoolAllocation contents because those are simply those values.
  // We could refactor the tests of those allocations to use the data now exposed by a notifier.
});

test('manager notifiers', async t => {
  const LOAN1 = 450n;
  const DEBT1 = 473n; // with penalty
  const LOAN2 = 50n;
  const DEBT2 = 53n; // with penalty
  const AMPLE = 100_000n;
  const ENOUGH = 10_000n;

  const { aeth, run } = t.context;
  const manualTimer = buildManualTimer(t.log, 0n, {
    timeStep: SECONDS_PER_WEEK,
    eventLoopIteration,
  });
  t.context.loanTiming = {
    chargingPeriod: SECONDS_PER_WEEK,
    recordingPeriod: SECONDS_PER_WEEK,
  };
  t.context.rates = {
    ...t.context.rates,
    interestRate: run.makeRatio(20n),
  };

  const services = await setupServices(
    t,
    makeRatio(1n, run.brand, 100n, aeth.brand),
    undefined,
    manualTimer,
    undefined,
    // tuned so first liquidations have overage and the second have shortfall
    3n * (DEBT1 + DEBT2),
    // manual timer steps with granularity of a week, which confuses the auction
    52n * 7n * 24n * 3600n,
  );

  const { aethVaultManager, vfPublic } = services.vaultFactory;
  const cm = await E(aethVaultManager).getPublicFacet();

  const m = await vaultManagerMetricsTracker(t, cm);

  trace('0. Creation');
  await m.assertInitial({
    // present
    numActiveVaults: 0,
    numLiquidatingVaults: 0,
    totalCollateral: aeth.make(0n),
    totalDebt: run.make(0n),
    retainedCollateral: aeth.make(0n),

    // running
    numLiquidationsCompleted: 0,
    totalOverageReceived: run.make(0n),
    totalProceedsReceived: run.make(0n),
    totalCollateralSold: aeth.make(0n),
    totalShortfallReceived: run.make(0n),
  });

  trace('1. Create a loan with ample collateral');
  /** @type {UserSeat<VaultKit>} */
  let vaultSeat = await E(services.zoe).offer(
    await E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: aeth.make(AMPLE) },
      want: { Minted: run.make(LOAN1) },
    }),
    harden({
      Collateral: t.context.aeth.mint.mintPayment(aeth.make(AMPLE)),
    }),
  );
  let { vault } = await E(vaultSeat).getOfferResult();
  let totalCollateral = AMPLE;
  let totalDebt = DEBT1;
  await m.assertChange({
    numActiveVaults: 1,
    totalCollateral: { value: totalCollateral },
    totalDebt: { value: totalDebt },
  });
  t.is((await E(vault).getCurrentDebt()).value, DEBT1);

  trace('2. Remove collateral');
  const COLL_REMOVED = 50_000n;
  const takeCollateralSeat = await E(services.zoe).offer(
    await E(vault).makeAdjustBalancesInvitation(),
    harden({
      give: {},
      want: { Collateral: aeth.make(COLL_REMOVED) },
    }),
  );
  await E(takeCollateralSeat).getOfferResult();
  await m.assertChange({
    totalCollateral: { value: totalCollateral - COLL_REMOVED },
  });

  trace('3. Make another LOAN1 loan');
  vaultSeat = await E(services.zoe).offer(
    await E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: aeth.make(AMPLE) },
      want: { Minted: run.make(LOAN1) },
    }),
    harden({
      Collateral: t.context.aeth.mint.mintPayment(aeth.make(AMPLE)),
    }),
  );
  ({ vault } = await E(vaultSeat).getOfferResult());
  totalCollateral += COLL_REMOVED;
  totalDebt += DEBT1;
  await m.assertChange({
    numActiveVaults: 2,
    totalCollateral: { value: totalCollateral },
    totalDebt: { value: totalDebt },
  });
  m.addDebt(DEBT1);
  t.is((await E(vault).getCurrentDebt()).value, DEBT1);

  trace('4. Make a LOAN2 loan');
  vaultSeat = await E(services.zoe).offer(
    await E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: aeth.make(ENOUGH) },
      want: { Minted: run.make(LOAN2) },
    }),
    harden({
      Collateral: t.context.aeth.mint.mintPayment(aeth.make(ENOUGH)),
    }),
  );
  ({ vault } = await E(vaultSeat).getOfferResult());
  totalCollateral += ENOUGH;
  totalDebt += DEBT2;
  await m.assertChange({
    numActiveVaults: 3,
    totalCollateral: { value: totalCollateral },
    totalDebt: { value: totalDebt },
  });
  m.addDebt(DEBT2);

  trace('5. Make another LOAN2 loan');
  vaultSeat = await E(services.zoe).offer(
    await E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: aeth.make(ENOUGH) },
      want: { Minted: run.make(LOAN2) },
    }),
    harden({
      Collateral: t.context.aeth.mint.mintPayment(aeth.make(ENOUGH)),
    }),
  );
  ({ vault } = await E(vaultSeat).getOfferResult());

  trace('6. Loan interest');
  vaultSeat = await E(services.zoe).offer(
    await E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: aeth.make(AMPLE) },
      want: { Minted: run.make(LOAN1) },
    }),
    harden({
      Collateral: t.context.aeth.mint.mintPayment(aeth.make(AMPLE)),
    }),
  );
  ({ vault } = await E(vaultSeat).getOfferResult());
  totalCollateral += ENOUGH;
  totalDebt += DEBT2;
  await m.assertChange({
    numActiveVaults: 4,
    totalCollateral: { value: totalCollateral },
    totalDebt: { value: totalDebt },
  });
  m.addDebt(DEBT2);
  await manualTimer.tickN(5);
  const interestAccrued = (await E(vault).getCurrentDebt()).value - DEBT1;
  m.addDebt(interestAccrued);
  t.is(interestAccrued, 9n);

  trace('7. make another loan to trigger a publish');
  vaultSeat = await E(services.zoe).offer(
    await E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: aeth.make(ENOUGH) },
      want: { Minted: run.make(LOAN2) },
    }),
    harden({
      Collateral: t.context.aeth.mint.mintPayment(aeth.make(ENOUGH)),
    }),
  );
  ({ vault } = await E(vaultSeat).getOfferResult());
  totalCollateral += AMPLE;
  totalDebt += DEBT1;
  await m.assertChange({
    numActiveVaults: 5,
    totalCollateral: { value: totalCollateral },
    totalDebt: { value: totalDebt },
  });
  m.addDebt(DEBT1);

  trace('8. Create a loan with ample collateral');
  /** @type {UserSeat<VaultKit>} */
  vaultSeat = await E(services.zoe).offer(
    await E(vfPublic).makeVaultInvitation(),
    harden({
      give: { Collateral: aeth.make(AMPLE) },
      want: { Minted: run.make(LOAN1) },
    }),
    harden({
      Collateral: t.context.aeth.mint.mintPayment(aeth.make(AMPLE)),
    }),
  );
  ({ vault } = await E(vaultSeat).getOfferResult());
  totalCollateral += ENOUGH;
  totalDebt += DEBT2 + 30n; // XXX ??
  m.addDebt(DEBT2);
  await m.assertChange({
    numActiveVaults: 6,
    totalCollateral: { value: totalCollateral },
    totalDebt: { value: totalDebt },
  });

  trace('9. Borrow more');
  const WANT_EXTRA = 400n;
  const DEBT1_EXTRA = DEBT1 + WANT_EXTRA + 20n; // 5% fee on extra
  // can't use 0n because of https://github.com/Agoric/agoric-sdk/issues/5548
  // but since this test is of metrics, we take the opportunity to check totalCollateral changing
  const given = aeth.make(2n);
  let vaultOpSeat = await E(services.zoe).offer(
    await E(vault).makeAdjustBalancesInvitation(),
    harden({
      // nominal collateral
      give: { Collateral: given },
      want: { Minted: run.make(WANT_EXTRA) },
    }),
    harden({
      Collateral: t.context.aeth.mint.mintPayment(given),
    }),
  );
  await E(vaultOpSeat).getOfferResult();
  totalCollateral += AMPLE;
  totalDebt += DEBT1;
  await m.assertChange({
    numActiveVaults: 7,
    totalDebt: { value: totalDebt },
    totalCollateral: { value: totalCollateral },
  });

  trace('10. Close loan');
  vaultOpSeat = await E(services.zoe).offer(
    await E(vault).makeCloseInvitation(),
    harden({
      give: { Minted: run.make(DEBT1_EXTRA) },
      want: {},
    }),
    harden({
      Minted: await getRunFromFaucet(t, DEBT1_EXTRA),
    }),
  );
  await E(vaultOpSeat).getOfferResult();
  totalCollateral += 2n;
  totalDebt += 420n;
  await m.assertChange({
    totalCollateral: { value: totalCollateral },
    totalDebt: { value: totalDebt },
  });
});

test('governance publisher', async t => {
  const { aeth } = t.context;
  t.context.loanTiming = {
    chargingPeriod: 2n,
    recordingPeriod: 10n,
  };

  const services = await setupServices(
    t,
    [500n, 15n],
    aeth.make(900n),
    undefined,
    undefined,
    500n,
  );
  const { vfPublic } = services.vaultFactory;
  const directorGovNotifier = makeNotifierFromAsyncIterable(
    E(vfPublic).getElectorateSubscription(),
  );
  let {
    value: { current },
  } = await directorGovNotifier.getUpdateSince();
  // can't deepEqual because of non-literal objects
  t.is(current.Electorate.type, 'invitation');
  t.is(current.MinInitialDebt.type, 'amount');
  t.is(current.ShortfallInvitation.type, 'invitation');

  const managerGovNotifier = makeNotifierFromAsyncIterable(
    E(vfPublic).getSubscription({
      collateralBrand: aeth.brand,
    }),
  );
  ({
    value: { current },
  } = await managerGovNotifier.getUpdateSince());
  // can't deepEqual because of non-literal objects
  t.is(current.DebtLimit.type, 'amount');
  t.is(current.InterestRate.type, 'ratio');
  t.is(current.LoanFee.type, 'ratio');
});
