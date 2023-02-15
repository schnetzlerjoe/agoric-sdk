import './types.js';

import {
  CONTRACT_ELECTORATE,
  makeParamManager,
  makeParamManagerSync,
  ParamTypes,
} from '@agoric/governance';
import { makeStoredPublisherKit } from '@agoric/notifier';
import { M } from '@agoric/store';
import { TimeMath } from '@agoric/time';
import { subtractRatios } from '@agoric/zoe/src/contractSupport/ratio.js';
import { amountPattern, ratioPattern } from '../contractSupport.js';

export const CHARGING_PERIOD_KEY = 'ChargingPeriod';
export const RECORDING_PERIOD_KEY = 'RecordingPeriod';

export const DEBT_LIMIT_KEY = 'DebtLimit';
export const LIQUIDATION_MARGIN_KEY = 'LiquidationMargin';
export const LIQUIDATION_PADDING_KEY = 'LiquidationPadding';
export const LIQUIDATION_PENALTY_KEY = 'LiquidationPenalty';
export const INTEREST_RATE_KEY = 'InterestRate';
export const LOAN_FEE_KEY = 'LoanFee';
export const LIQUIDATION_INSTALL_KEY = 'LiquidationInstall';
export const LIQUIDATION_TERMS_KEY = 'LiquidationTerms';
export const MIN_INITIAL_DEBT_KEY = 'MinInitialDebt';
export const SHORTFALL_INVITATION_KEY = 'ShortfallInvitation';
export const ENDORSED_UI_KEY = 'EndorsedUI';

/**
 * @param {Amount} electorateInvitationAmount
 * @param {Installation} liquidationInstall
 * @param {import('./liquidation.js').LiquidationTerms} liquidationTerms
 * @param {Amount} minInitialDebt
 * @param {Amount} shortfallInvitationAmount
 * @param {string} endorsedUi
 */
const makeVaultDirectorParams = (
  electorateInvitationAmount,
  liquidationInstall,
  liquidationTerms,
  minInitialDebt,
  shortfallInvitationAmount,
  endorsedUi,
) => {
  return harden({
    [CONTRACT_ELECTORATE]: {
      type: ParamTypes.INVITATION,
      value: electorateInvitationAmount,
    },
    [LIQUIDATION_INSTALL_KEY]: {
      type: ParamTypes.INSTALLATION,
      value: liquidationInstall,
    },
    [LIQUIDATION_TERMS_KEY]: {
      type: ParamTypes.UNKNOWN,
      value: liquidationTerms,
    },
    [MIN_INITIAL_DEBT_KEY]: {
      type: ParamTypes.AMOUNT,
      value: minInitialDebt,
    },
    [SHORTFALL_INVITATION_KEY]: {
      type: ParamTypes.INVITATION,
      value: shortfallInvitationAmount,
    },
    [ENDORSED_UI_KEY]: { type: ParamTypes.STRING, value: endorsedUi },
  });
};
harden(makeVaultDirectorParams);

/** @typedef {import('@agoric/governance/src/contractGovernance/typedParamManager').ParamTypesMapFromRecord<ReturnType<typeof makeVaultDirectorParams>>} VaultDirectorParams */

/** @type {(liquidationMargin: Ratio) => Ratio} */
const zeroRatio = liquidationMargin =>
  subtractRatios(liquidationMargin, liquidationMargin);

/**
 * @param {import('@agoric/notifier').StoredPublisherKit<GovernanceSubscriptionState>} publisherKit
 * @param {VaultManagerParamValues} initial
 */
export const makeVaultParamManager = (
  publisherKit,
  {
    debtLimit,
    interestRate,
    liquidationMargin,
    liquidationPadding = zeroRatio(liquidationMargin),
    liquidationPenalty,
    loanFee,
  },
) =>
  makeParamManagerSync(publisherKit, {
    [DEBT_LIMIT_KEY]: [ParamTypes.AMOUNT, debtLimit],
    [INTEREST_RATE_KEY]: [ParamTypes.RATIO, interestRate],
    [LIQUIDATION_PADDING_KEY]: [ParamTypes.RATIO, liquidationPadding],
    [LIQUIDATION_MARGIN_KEY]: [ParamTypes.RATIO, liquidationMargin],
    [LIQUIDATION_PENALTY_KEY]: [ParamTypes.RATIO, liquidationPenalty],
    [LOAN_FEE_KEY]: [ParamTypes.RATIO, loanFee],
  });
/** @typedef {ReturnType<typeof makeVaultParamManager>} VaultParamManager */

export const vaultParamPattern = M.splitRecord(
  {
    liquidationMargin: ratioPattern,
    liquidationPenalty: ratioPattern,
    interestRate: ratioPattern,
    loanFee: ratioPattern,
    debtLimit: amountPattern,
  },
  {
    // optional for backwards compatibility, e.g. with loadgen
    liquidationPadding: ratioPattern,
  },
);

/**
 * @param {import('@agoric/notifier').StoredPublisherKit<GovernanceSubscriptionState>} publisherKit
 * @param {ERef<ZoeService>} zoe
 * @param {Invitation} electorateInvitation
 * @param {Installation} liquidationInstall
 * @param {object} liquidationTerms
 * @param {Amount} minInitialDebt
 * @param {Invitation} shortfallInvitation
 * @param {string} [endorsedUi]
 */
export const makeVaultDirectorParamManager = async (
  publisherKit,
  zoe,
  electorateInvitation,
  liquidationInstall,
  liquidationTerms,
  minInitialDebt,
  shortfallInvitation,
  endorsedUi = 'NO ENDORSEMENT',
) => {
  return makeParamManager(
    publisherKit,
    {
      [CONTRACT_ELECTORATE]: [ParamTypes.INVITATION, electorateInvitation],
      [LIQUIDATION_INSTALL_KEY]: [ParamTypes.INSTALLATION, liquidationInstall],
      [LIQUIDATION_TERMS_KEY]: [ParamTypes.UNKNOWN, liquidationTerms],
      [MIN_INITIAL_DEBT_KEY]: [ParamTypes.AMOUNT, minInitialDebt],
      [SHORTFALL_INVITATION_KEY]: [ParamTypes.INVITATION, shortfallInvitation],
      [ENDORSED_UI_KEY]: [ParamTypes.STRING, endorsedUi],
    },
    zoe,
  );
};
harden(makeVaultDirectorParamManager);

/**
 * @param {{storageNode: ERef<StorageNode>, marshaller: ERef<Marshaller>}} caps
 * @param {{
 *   electorateInvitationAmount: Amount,
 *   minInitialDebt: Amount,
 *   bootstrapPaymentValue: bigint,
 *   priceAuthority: ERef<PriceAuthority>,
 *   timer: ERef<import('@agoric/time/src/types').TimerService>,
 *   reservePublicFacet: AssetReservePublicFacet,
 *   liquidationInstall: Installation,
 *   loanTiming: LoanTiming,
 *   liquidationTerms: import('./liquidation.js').LiquidationTerms,
 *   ammPublicFacet: XYKAMMPublicFacet,
 *   shortfallInvitationAmount: Amount,
 *   auctionPublicFacet: import('../auction/auctioneer.js').AuctioneerPublicFacet,
 *   endorsedUi?: string,
 * }} opts
 */
export const makeGovernedTerms = (
  { storageNode, marshaller },
  {
    ammPublicFacet,
    bootstrapPaymentValue,
    auctionPublicFacet,
    electorateInvitationAmount,
    liquidationInstall,
    liquidationTerms,
    loanTiming,
    minInitialDebt,
    priceAuthority,
    reservePublicFacet,
    timer,
    shortfallInvitationAmount,
    endorsedUi = 'NO ENDORSEMENT',
  },
) => {
  const loanTimingParams = makeParamManagerSync(
    makeStoredPublisherKit(storageNode, marshaller, 'timingParams'),
    {
      [CHARGING_PERIOD_KEY]: [
        'nat',
        TimeMath.relValue(loanTiming.chargingPeriod),
      ],
      [RECORDING_PERIOD_KEY]: [
        'nat',
        TimeMath.relValue(loanTiming.recordingPeriod),
      ],
    },
  ).getParams();

  return harden({
    ammPublicFacet,
    priceAuthority,
    auctionPublicFacet,
    loanTimingParams,
    reservePublicFacet,
    timerService: timer,
    governedParams: makeVaultDirectorParams(
      electorateInvitationAmount,
      liquidationInstall,
      liquidationTerms,
      minInitialDebt,
      shortfallInvitationAmount,
      endorsedUi,
    ),
    bootstrapPaymentValue,
  });
};
harden(makeGovernedTerms);
