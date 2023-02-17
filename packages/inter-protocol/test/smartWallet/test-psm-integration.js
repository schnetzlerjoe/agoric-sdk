import { test as anyTest } from '@agoric/zoe/tools/prepare-test-env-ava.js';

import { AmountMath, makeIssuerKit } from '@agoric/ertp';
import { buildRootObject as buildPSMRootObject } from '@agoric/vats/src/core/boot-psm.js';
import '@agoric/vats/src/core/types.js';
import { Stable } from '@agoric/vats/src/tokens.js';
import {
  mockDProxy,
  mockPsmBootstrapArgs,
} from '@agoric/vats/tools/boot-test-utils.js';
import { eventLoopIteration } from '@agoric/zoe/tools/eventLoopIteration.js';
import { E } from '@endo/far';
import { NonNullish } from '@agoric/assert';

import {
  coalesceUpdates,
  sequenceUpdates,
} from '@agoric/smart-wallet/src/utils.js';
import { INVITATION_MAKERS_DESC } from '../../src/econCommitteeCharter.js';
import {
  currentPurseBalance,
  makeDefaultTestContext,
  voteForOpenQuestion,
} from './contexts.js';
import { headValue, withAmountUtils } from '../supports.js';

/**
 * @type {import('ava').TestFn<Awaited<ReturnType<makeDefaultTestContext>>
 * & {consume: import('@agoric/inter-protocol/src/proposals/econ-behaviors.js').EconomyBootstrapPowers['consume']}>
 * }
 */
const test = anyTest;

const committeeAddress = 'psmTestAddress';

const makePsmTestSpace = async log => {
  const psmParams = {
    anchorAssets: [{ denom: 'ibc/toyusdc', keyword: 'AUSD' }],
    economicCommitteeAddresses: { aMember: committeeAddress },
    argv: { bootMsg: {} },
  };

  const psmVatRoot = await buildPSMRootObject(
    {
      logger: log,
      D: mockDProxy,
    },
    psmParams,
  );
  void psmVatRoot.bootstrap(...mockPsmBootstrapArgs(log));

  // @ts-expect-error cast
  return /** @type {ChainBootstrapSpace} */ (psmVatRoot.getPromiseSpace());
};

test.before(async t => {
  // @ts-expect-error cast
  t.context = await makeDefaultTestContext(t, makePsmTestSpace);
});

test('null swap', async t => {
  const { anchor } = t.context;
  const { agoricNames } = await E.get(t.context.consume);
  const mintedBrand = await E(agoricNames).lookup('brand', 'IST');

  const { getBalanceFor, wallet } = await t.context.provideWalletAndBalances(
    'agoric1nullswap',
  );
  const updates = sequenceUpdates(E(wallet).getUpdatesSubscriber());

  /** @type {import('@agoric/smart-wallet/src/invitations').AgoricContractInvitationSpec} */
  const invitationSpec = {
    source: 'agoricContract',
    instancePath: ['psm-IST-AUSD'],
    callPipe: [['makeGiveMintedInvitation']],
  };

  await wallet.getOffersFacet().executeOffer({
    id: 'nullSwap',
    invitationSpec,
    proposal: {
      // empty amounts
      give: { In: AmountMath.makeEmpty(mintedBrand) },
      want: { Out: anchor.makeEmpty() },
    },
  });

  await eventLoopIteration();

  t.like(updates[0], {
    updated: 'balance',
  });

  const statusUpdateHasKeys = (updateIndex, result, numWants, payouts) => {
    const { status } = updates[updateIndex];
    t.is('result' in status, result, 'result');
    t.is('numWantsSatisfied' in status, numWants, 'numWantsSatisfied');
    t.is('payouts' in status, payouts, 'payouts');
    t.false('error' in status);
  };

  statusUpdateHasKeys(1, false, false, false);
  statusUpdateHasKeys(2, true, false, false);
  statusUpdateHasKeys(3, true, true, false);
  statusUpdateHasKeys(4, true, true, true);

  t.is(await E.get(getBalanceFor(anchor.brand)).value, 0n);
  t.is(await E.get(getBalanceFor(mintedBrand)).value, 0n);
});

// we test this direciton of swap because wanting anchor would require the PSM to have anchor in it first
test('want stable', async t => {
  const { anchor } = t.context;
  const { agoricNames } = await E.get(t.context.consume);

  const swapSize = 10_000n;

  t.log('Start the PSM to ensure brands are registered');
  const stableBrand = await E(agoricNames).lookup('brand', Stable.symbol);

  const { getBalanceFor, wallet } = await t.context.provideWalletAndBalances(
    'agoric1wantstable',
  );

  const offersFacet = wallet.getOffersFacet();
  t.assert(offersFacet, 'undefined offersFacet');

  t.is(await E.get(getBalanceFor(anchor.brand)).value, 0n);

  t.log('Fund the wallet');
  assert(anchor.mint);
  const payment = anchor.mint.mintPayment(anchor.make(swapSize));
  // @ts-expect-error deposit does take a FarRef<Payment>
  await wallet.getDepositFacet().receive(payment);

  t.log('Prepare the swap');

  t.log('Execute the swap');
  /** @type {import('@agoric/smart-wallet/src/invitations').AgoricContractInvitationSpec} */
  const invitationSpec = {
    source: 'agoricContract',
    instancePath: ['psm-IST-AUSD'],
    callPipe: [['makeWantMintedInvitation']],
  };

  await offersFacet.executeOffer({
    id: 1,
    invitationSpec,
    proposal: {
      give: { In: anchor.make(swapSize) },
      want: {},
    },
  });
  await eventLoopIteration();
  t.is(await E.get(getBalanceFor(anchor.brand)).value, 0n);
  t.is(await E.get(getBalanceFor(stableBrand)).value, swapSize); // assume 0% fee
});

test('govern offerFilter', async t => {
  const { anchor, invitationBrand } = t.context;
  const { agoricNames, psmKit, zoe } = await E.get(t.context.consume);

  const { psm: psmInstance } = await E(psmKit).get(anchor.brand);

  const wallet = await t.context.simpleProvideWallet(committeeAddress);
  const computedState = coalesceUpdates(
    E(wallet).getUpdatesSubscriber(),
    invitationBrand,
  );
  const currentSub = E(wallet).getCurrentSubscriber();

  const offersFacet = wallet.getOffersFacet();

  const econCharter = await E(agoricNames).lookup(
    'instance',
    'econCommitteeCharter',
  );
  const economicCommittee = await E(agoricNames).lookup(
    'instance',
    'economicCommittee',
  );
  await eventLoopIteration();

  /**
   * get invitation details the way a user would
   *
   * @param {string} desc
   * @param {number} len
   * @param {any} balances XXX please improve this
   * @returns {Promise<[{description: string, instance: Instance}]>}
   */
  const getInvitationFor = async (desc, len, balances) =>
    // @ts-expect-error TS can't tell that it's going to satisfy the @returns.
    E(E(zoe).getInvitationIssuer())
      .getBrand()
      .then(brand => {
        t.is(
          brand,
          invitationBrand,
          'invitation brand from context matches zoe',
        );
        /** @type {Amount<'set'>} */
        const invitationsAmount = NonNullish(balances.get(brand));
        t.is(invitationsAmount?.value.length, len, 'invitation count');
        return invitationsAmount.value.filter(i => i.description === desc);
      });

  const proposeInvitationDetails = await getInvitationFor(
    INVITATION_MAKERS_DESC,
    2,
    computedState.balances,
  );

  t.is(proposeInvitationDetails[0].description, INVITATION_MAKERS_DESC);
  t.is(proposeInvitationDetails[0].instance, econCharter, 'econCharter');
  t.is(
    // @ts-expect-error cast amount kind
    currentPurseBalance(await headValue(currentSub), invitationBrand).length,
    2,
    'two invitations deposited',
  );

  // The purse has the invitation to get the makers ///////////

  /** @type {import('@agoric/smart-wallet/src/invitations').PurseInvitationSpec} */
  const getInvMakersSpec = {
    source: 'purse',
    instance: econCharter,
    description: INVITATION_MAKERS_DESC,
  };

  await offersFacet.executeOffer({
    id: 'acceptEcInvitationOID',
    invitationSpec: getInvMakersSpec,
    proposal: {},
  });

  /** @type {import('@agoric/smart-wallet/src/smartWallet.js').CurrentWalletRecord} */
  let currentState = await headValue(currentSub);
  t.is(
    // @ts-expect-error cast amount kind
    currentPurseBalance(currentState, invitationBrand).length,
    1,
    'one invitation consumed, one left',
  );
  t.deepEqual(Object.keys(currentState.offerToUsedInvitation), [
    'acceptEcInvitationOID',
  ]);
  t.is(
    currentState.offerToUsedInvitation.acceptEcInvitationOID.value[0]
      .description,
    'charter member invitation',
  );
  const voteInvitationDetails = await getInvitationFor(
    'Voter0',
    1,
    computedState.balances,
  );
  t.is(voteInvitationDetails.length, 1);
  const voteInvitationDetail = voteInvitationDetails[0];
  t.is(voteInvitationDetail.description, 'Voter0');
  t.is(voteInvitationDetail.instance, economicCommittee);

  /** @type {import('@agoric/smart-wallet/src/invitations').PurseInvitationSpec} */
  const getCommitteeInvMakersSpec = {
    source: 'purse',
    instance: economicCommittee,
    description: 'Voter0',
  };

  await offersFacet.executeOffer({
    id: 'acceptVoterOID',
    invitationSpec: getCommitteeInvMakersSpec,
    proposal: {},
  });
  currentState = await headValue(currentSub);
  t.is(
    // @ts-expect-error cast amount kind
    currentPurseBalance(currentState, invitationBrand).length,
    0,
    'last invitation consumed, none left',
  );
  t.deepEqual(Object.keys(currentState.offerToUsedInvitation), [
    'acceptEcInvitationOID',
    'acceptVoterOID',
  ]);
  // acceptEcInvitationOID tested above
  t.is(
    currentState.offerToUsedInvitation.acceptVoterOID.value[0].description,
    'Voter0',
  );

  // Call for a vote ////////////////////////////////

  /** @type {import('@agoric/smart-wallet/src/invitations').ContinuingInvitationSpec} */
  const proposeInvitationSpec = {
    source: 'continuing',
    previousOffer: 'acceptEcInvitationOID',
    invitationMakerName: 'VoteOnPauseOffers',
    invitationArgs: harden([psmInstance, ['wantStable'], 2n]),
  };

  await offersFacet.executeOffer({
    id: 'proposeVoteOnPauseOffers',
    invitationSpec: proposeInvitationSpec,
    proposal: {},
  });
  await eventLoopIteration();

  // vote /////////////////////////

  const committeePublic = E(zoe).getPublicFacet(economicCommittee);

  await offersFacet.executeOffer({
    id: 'voteForPauseOffers',
    invitationSpec: await voteForOpenQuestion(
      committeePublic,
      'acceptVoterOID',
    ),
    proposal: {},
  });
  await eventLoopIteration();

  // can't advance the clock, so the vote won't close. Call it enuf that the
  // vote didn't raise an error.
});

test('deposit unknown brand', async t => {
  const rial = withAmountUtils(makeIssuerKit('rial'));
  assert(rial.mint);

  const wallet = await t.context.simpleProvideWallet('agoric1queue');

  const payment = rial.mint.mintPayment(rial.make(1_000n));
  // @ts-expect-error deposit does take a FarRef<Payment>
  const result = await wallet.getDepositFacet().receive(harden(payment));
  // successful request but not deposited
  t.deepEqual(result, { brand: rial.brand, value: 0n });
});

test.failing('deposit > 1 payment to unknown brand #6961', async t => {
  const rial = withAmountUtils(makeIssuerKit('rial'));

  const wallet = await t.context.simpleProvideWallet('agoric1queue');

  for await (const _ of [1, 2]) {
    const payment = rial.mint.mintPayment(rial.make(1_000n));
    // @ts-expect-error deposit does take a FarRef<Payment>
    const result = await wallet.getDepositFacet().receive(harden(payment));
    // successful request but not deposited
    t.deepEqual(result, { brand: rial.brand, value: 0n });
  }
});

// XXX belongs in smart-wallet package, but needs lots of set-up that's handy here.
test('recover when some withdrawals succeed and others fail', async t => {
  const { fromEntries } = Object;
  const { make } = AmountMath;
  const { anchor } = t.context;
  const { agoricNames, bankManager } = t.context.consume;
  const getBalance = (addr, brand) => {
    const bank = E(bankManager).getBankForAddress(addr);
    const purse = E(bank).getPurse(brand);
    return E(purse).getCurrentAmount();
  };
  const namedBrands = kws =>
    Promise.all(
      kws.map(kw =>
        E(agoricNames)
          .lookup('brand', kw)
          .then(b => [kw, b]),
      ),
    ).then(fromEntries);

  t.log('Johnny has 10 AUSD');
  const jAddr = 'addrForJohnny';
  const smartWallet = await t.context.simpleProvideWallet(jAddr);
  await E(E(smartWallet).getDepositFacet()).receive(
    // @ts-expect-error FarRef grumble
    E(anchor.mint).mintPayment(make(anchor.brand, 10n)),
  );
  t.deepEqual(await getBalance(jAddr, anchor.brand), make(anchor.brand, 10n));

  t.log('He accidentally offers 10 BLD as well in a trade for IST');
  const instance = await E(agoricNames).lookup('instance', 'psm-IST-AUSD');
  const brand = await namedBrands(['BLD', 'IST']);
  const proposal = harden({
    give: { Anchor: make(anchor.brand, 10n), Oops: make(brand.BLD, 10n) },
    want: { Proceeds: make(brand.IST, 1n) },
  });
  await E(smartWallet.getOffersFacet()).executeOffer({
    id: 'recover',
    invitationSpec: {
      source: 'contract',
      instance,
      publicInvitationMaker: 'makeWantMintedInvitation',
      invitationArgs: [],
    },
    proposal,
  });

  t.log('He still has 10 AUSD');
  t.deepEqual(await getBalance(jAddr, anchor.brand), make(anchor.brand, 10n));
});

// TODO move to smart-wallet package when it has sufficient test supports
test('agoricName invitation source errors', async t => {
  const { anchor } = t.context;
  const { agoricNames } = await E.get(t.context.consume);
  const mintedBrand = await E(agoricNames).lookup('brand', 'IST');

  const { getBalanceFor, wallet } = await t.context.provideWalletAndBalances(
    'agoric1nullswap',
  );
  const computedState = coalesceUpdates(E(wallet).getUpdatesSubscriber());

  await wallet.getOffersFacet().executeOffer({
    id: 'missing property',
    // @ts-expect-error intentional violation
    invitationSpec: {
      source: 'agoricContract',
      instancePath: ['psm-IST-AUSD'],
      // callPipe: [['makeGiveMintedInvitation']],
    },
    proposal: {},
  });
  t.is(await E.get(getBalanceFor(anchor.brand)).value, 0n);
  t.is(await E.get(getBalanceFor(mintedBrand)).value, 0n);
  t.like(computedState.offerStatuses.get('missing property'), {
    error:
      'Error: {"source":"agoricContract","instancePath":["psm-IST-AUSD"]} - Must have missing properties ["callPipe"]',
  });

  await wallet.getOffersFacet().executeOffer({
    id: 'bad namepath',
    invitationSpec: {
      source: 'agoricContract',
      instancePath: ['not-present'],
      callPipe: [['makeGiveMintedInvitation']],
    },
    proposal: {},
  });
  t.is(await E.get(getBalanceFor(anchor.brand)).value, 0n);
  t.is(await E.get(getBalanceFor(mintedBrand)).value, 0n);
  t.like(computedState.offerStatuses.get('bad namepath'), {
    error: 'Error: "nameKey" not found: "not-present"',
  });

  await wallet.getOffersFacet().executeOffer({
    id: 'method typo',
    invitationSpec: {
      source: 'agoricContract',
      instancePath: ['psm-IST-AUSD'],
      callPipe: [['makeGiveMintedInvitation ']],
    },
    proposal: {},
  });
  t.is(await E.get(getBalanceFor(anchor.brand)).value, 0n);
  t.is(await E.get(getBalanceFor(mintedBrand)).value, 0n);
  t.like(computedState.offerStatuses.get('method typo'), {
    error:
      'TypeError: target has no method "makeGiveMintedInvitation ", has []',
  });

  await wallet.getOffersFacet().executeOffer({
    id: 'long pipe',
    invitationSpec: {
      source: 'agoricContract',
      instancePath: ['psm-IST-AUSD'],
      callPipe: [
        ['zoe.getPublicFacet'],
        ['makeGiveMintedInvitation'],
        ['excessiveCall'],
      ],
    },
    proposal: {},
  });
  t.is(await E.get(getBalanceFor(anchor.brand)).value, 0n);
  t.is(await E.get(getBalanceFor(mintedBrand)).value, 0n);
  t.like(computedState.offerStatuses.get('long pipe'), {
    error: 'Error: callPipe longer than MAX_PIPE_LENGTH=2',
  });
});

test.todo('bad offer schema');
test.todo('not enough funds');
test.todo(
  'a faulty issuer that never returns and additional offers can still flow',
);
