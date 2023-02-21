import {
  AmountShape,
  AssetKindShape,
  DisplayInfoShape,
  IssuerShape,
  BrandShape,
  PaymentShape,
  IssuerKitShape,
} from '@agoric/ertp';
import { M } from '@agoric/store';
import { TimestampValueShape } from '@agoric/time';
import { SubscriberShape } from '@agoric/notifier';

// keywords have an initial cap
export const KeywordShape = M.string();

export const InvitationHandleShape = M.remotable('InvitationHandle');
export const InvitationShape = M.remotable('Invitation');
export const InstanceHandleShape = M.remotable('InstanceHandle');
export const InstallationShape = M.remotable('Installation');
export const SeatShape = M.remotable('Seat');

export const AmountKeywordRecordShape = M.recordOf(KeywordShape, AmountShape);
export const AmountPatternKeywordRecordShape = M.recordOf(
  KeywordShape,
  M.pattern(),
);
export const PaymentPKeywordRecordShape = M.recordOf(
  KeywordShape,
  M.eref(PaymentShape),
);
export const IssuerKeywordRecordShape = M.recordOf(KeywordShape, IssuerShape);
export const IssuerPKeywordRecordShape = M.recordOf(
  KeywordShape,
  M.eref(IssuerShape),
);
export const BrandKeywordRecordShape = M.recordOf(KeywordShape, BrandShape);

export const IssuerRecordShape = M.splitRecord(
  {
    brand: BrandShape,
    issuer: IssuerShape,
    assetKind: AssetKindShape,
  },
  { displayInfo: DisplayInfoShape },
);

export const TermsShape = harden({
  issuers: IssuerKeywordRecordShape,
  brands: BrandKeywordRecordShape,
});

export const InstanceRecordShape = harden({
  installation: InstallationShape,
  instance: InstanceHandleShape,
  terms: M.splitRecord(TermsShape),
});

export const HandleI = M.interface('Handle', {});

export const makeHandleShape = name => M.remotable(`${name}Handle`);
export const TimerShape = makeHandleShape('timer');

/**
 * After defaults are filled in
 *
 * @see {ProposalRecord} type
 */
export const FullProposalShape = harden({
  want: AmountPatternKeywordRecordShape,
  give: AmountKeywordRecordShape,
  // To accept only one, we could use M.or rather than M.splitRecord,
  // but the error messages would have been worse. Rather,
  // cleanProposal's assertExit checks that there's exactly one.
  exit: M.splitRecord(
    {},
    {
      onDemand: null,
      waived: null,
      afterDeadline: {
        timer: M.eref(TimerShape),
        deadline: TimestampValueShape,
      },
    },
    {},
  ),
});
/** @see {Proposal} type */
export const ProposalShape = M.splitRecord({}, FullProposalShape, {});

export const EmptyProposalShape = M.splitRecord({
  give: {},
  want: {},
  exit: { onDemand: null },
});

export const isOnDemandExitRule = exit => {
  const [exitKey] = Object.keys(exit);
  return exitKey === 'onDemand';
};

/**
 * @param {ExitRule} exit
 * @returns {exit is WaivedExitRule}
 */
export const isWaivedExitRule = exit => {
  const [exitKey] = Object.keys(exit);
  return exitKey === 'waived';
};

/**
 * @param {ExitRule} exit
 * @returns {exit is AfterDeadlineExitRule}
 */
export const isAfterDeadlineExitRule = exit => {
  const [exitKey] = Object.keys(exit);
  return exitKey === 'afterDeadline';
};

export const InvitationElementShape = M.splitRecord({
  description: M.string(),
  handle: InvitationHandleShape,
  instance: InstanceHandleShape,
  installation: InstallationShape,
});

export const OfferHandlerI = M.interface('OfferHandler', {
  handle: M.call(SeatShape).optional(M.any()).returns(M.string()),
});

export const SeatHandleAllocationsShape = M.arrayOf(
  harden({
    seatHandle: SeatShape,
    allocation: AmountKeywordRecordShape,
  }),
);

export const ZoeMintShape = M.remotable('ZoeMint');
export const ZoeMintI = M.interface('ZoeMint', {
  getIssuerRecord: M.call().returns(IssuerRecordShape),
  mintAndEscrow: M.call(AmountShape).returns(),
  withdrawAndBurn: M.call(AmountShape).returns(),
});

export const ZcfMintI = M.interface('ZcfMint', {
  getIssuerRecord: M.call().returns(IssuerRecordShape),
  mintGains: M.call(AmountKeywordRecordShape, M.remotable('zcfSeat')).returns(),
  burnLosses: M.call(
    AmountKeywordRecordShape,
    M.remotable('zcfSeat'),
  ).returns(),
});

export const ExitObjectI = M.interface('Exit Object', {
  exit: M.call().returns(),
});

export const ExitObjectShape = M.remotable('ExitObj');
export const InstanceAdminShape = M.remotable('InstanceAdmin');
export const InstanceAdminI = M.interface('InstanceAdmin', {
  makeInvitation: M.call(InvitationHandleShape, M.string())
    .optional(M.record(), M.pattern())
    .returns(InvitationShape),
  saveIssuer: M.callWhen(M.await(IssuerShape), KeywordShape).returns(
    IssuerRecordShape,
  ),
  makeNoEscrowSeat: M.call(
    AmountKeywordRecordShape,
    ProposalShape,
    ExitObjectShape,
    SeatShape,
  ).returns(SeatShape),
  exitAllSeats: M.call(M.any()).returns(),
  failAllSeats: M.call(M.any()).returns(),
  exitSeat: M.call(SeatShape, M.any()).returns(),
  failSeat: M.call(SeatShape, M.any()).returns(),
  makeZoeMint: M.call(KeywordShape)
    .optional(
      AssetKindShape,
      DisplayInfoShape,
      M.splitRecord(harden({}), harden({ elementShape: M.pattern() })),
    )
    .returns(M.remotable('zoeMint')),
  registerFeeMint: M.call(KeywordShape, M.remotable('feeMintAccess')).returns(
    M.remotable('feeMint'),
  ),
  replaceAllocations: M.call(SeatHandleAllocationsShape).returns(),
  stopAcceptingOffers: M.call().returns(),
  setOfferFilter: M.call(M.arrayOf(M.string())).returns(),
  getOfferFilter: M.call().returns(M.arrayOf(M.string())),
  getExitSubscriber: M.call(SeatShape).returns(SubscriberShape),
  isBlocked: M.call(M.string()).returns(M.boolean()),
});

export const InstanceStorageManagerIKit = harden({
  instanceStorageManager: M.interface('InstanceStorageManager', {
    getTerms: M.call().returns(M.splitRecord(TermsShape)),
    getIssuers: M.call().returns(IssuerKeywordRecordShape),
    getBrands: M.call().returns(BrandKeywordRecordShape),
    getInstallation: M.call().returns(InstallationShape),
    getInvitationIssuer: M.call().returns(IssuerShape),

    saveIssuer: M.call(IssuerShape, KeywordShape).returns(M.promise()),
    makeZoeMint: M.call(KeywordShape)
      .optional(
        AssetKindShape,
        DisplayInfoShape,
        M.splitRecord(harden({}), harden({ elementShape: M.pattern() })),
      )
      .returns(M.eref(ZoeMintShape)),
    registerFeeMint: M.call(KeywordShape, M.remotable('feeMintAccess')).returns(
      M.remotable('feeMint'),
    ),
    getInstanceRecord: M.call().returns(InstanceRecordShape),
    getIssuerRecords: M.call().returns(M.arrayOf(IssuerRecordShape)),
    getWithdrawFacet: M.call().returns(M.remotable('WithdrawFacet')),
    initInstanceAdmin: M.call(
      InstanceHandleShape,
      M.remotable('instanceAdmin'),
    ).returns(M.promise()),
    deleteInstanceAdmin: M.call(InstanceAdminI).returns(),
    makeInvitation: M.call(InvitationHandleShape, M.string())
      .optional(M.record(), M.pattern())
      .returns(PaymentShape),
    getRoot: M.call().returns(M.any()),
    getAdminNode: M.call().returns(M.remotable('adminNode')),
  }),
  withdrawFacet: M.interface('WithdrawFacet', {
    withdrawPayments: M.call(AmountKeywordRecordShape).returns(
      PaymentPKeywordRecordShape,
    ),
  }),
  helpers: M.interface('InstanceStorageManager helper', {
    wrapIssuerKitWithZoeMint: M.call(
      KeywordShape,
      IssuerKitShape,
      M.remotable('adminNode'),
    ).returns(ZoeMintShape),
  }),
});

export const BundleCapShape = M.remotable('bundleCap');
export const BundleShape = M.and(
  M.splitRecord({ moduleFormat: M.any() }),
  M.recordOf(M.string(), M.string({ stringLengthLimit: Infinity })),
);

export const ZoeStorageManagerIKit = harden({
  zoeServiceDataAccess: M.interface('ZoeService dataAccess', {
    getTerms: M.call(InstanceHandleShape).returns(M.splitRecord(TermsShape)),
    getIssuers: M.call(InstanceHandleShape).returns(IssuerKeywordRecordShape),
    getBrands: M.call(InstanceHandleShape).returns(BrandKeywordRecordShape),
    getInstallation: M.call(InstanceHandleShape).returns(
      M.eref(M.remotable('Installation')),
    ),
    getInvitationIssuer: M.call().returns(IssuerShape),

    getBundleIDFromInstallation: M.call(InstallationShape).returns(
      M.eref(M.string()),
    ),
    installBundle: M.call(M.or(InstanceHandleShape, BundleShape)).returns(
      M.promise(),
    ),
    installBundleID: M.call(M.string()).returns(M.promise()),

    getPublicFacet: M.call(InstanceHandleShape).returns(
      M.eref(M.remotable('PublicFacet')),
    ),
    getOfferFilter: M.call(InstanceHandleShape).returns(M.arrayOf(M.string())),
    getProposalShapeForInvitation: M.call(InvitationHandleShape).returns(
      M.opt(M.pattern()),
    ),
  }),
  makeOfferAccess: M.interface('ZoeStorage makeOffer access', {
    getAssetKindByBrand: M.call(BrandShape).returns(AssetKindShape),
    getInstanceAdmin: M.call(InstanceHandleShape).returns(
      M.remotable('instanceAdmin'),
    ),
    getProposalShapeForInvitation: M.call(InvitationHandleShape).returns(
      M.opt(M.pattern()),
    ),
    getInvitationIssuer: M.call().returns(IssuerShape),
    depositPayments: M.call(ProposalShape, PaymentPKeywordRecordShape).returns(
      M.promise(),
    ),
  }),
  startInstanceAccess: M.interface('ZoeStorage startInstance access', {
    makeZoeInstanceStorageManager: M.call(
      M.any(),
      InstallationShape,
      M.any(),
      IssuerPKeywordRecordShape,
      M.or(InstanceHandleShape, BundleShape),
      M.or(BundleCapShape, BundleShape),
    ).returns(M.promise()),
    unwrapInstallation: M.callWhen(M.eref(InstallationShape)).returns(M.any()),
  }),
  invitationIssuerAccess: M.interface('ZoeStorage invitationIssuer', {
    getInvitationIssuer: M.call().returns(IssuerShape),
  }),
});

export const ZoeServiceI = M.interface('ZoeService', {
  install: M.call(M.any()).returns(M.promise()),
  installBundleID: M.call(M.string()).returns(M.promise()),
  startInstance: M.call(M.eref(InstallationShape))
    .optional(IssuerPKeywordRecordShape, M.any(), M.any())
    .returns(M.promise()),
  offer: M.call(M.eref(InvitationShape))
    .optional(ProposalShape, PaymentPKeywordRecordShape, M.any())
    .returns(M.promise()),

  getOfferFilter: M.callWhen(M.await(InstanceHandleShape)).returns(
    M.arrayOf(M.string()),
  ),
  getInvitationIssuer: M.call().returns(M.promise()),
  getFeeIssuer: M.call().returns(M.promise()),
  getBrands: M.callWhen(M.await(InstanceHandleShape)).returns(
    BrandKeywordRecordShape,
  ),
  getIssuers: M.callWhen(M.await(InstanceHandleShape)).returns(
    IssuerKeywordRecordShape,
  ),
  getPublicFacet: M.callWhen(M.await(InstanceHandleShape)).returns(
    M.remotable('PublicFacet'),
  ),
  getTerms: M.callWhen(M.await(InstanceHandleShape)).returns(M.any()),
  getInstallationForInstance: M.callWhen(M.await(InstanceHandleShape)).returns(
    M.eref(M.remotable('Installation')),
  ),
  getBundleIDFromInstallation: M.call(InstallationShape).returns(
    M.eref(M.string()),
  ),

  getInstallation: M.call(M.eref(InvitationShape)).returns(M.promise()),
  getInstance: M.call(M.eref(InvitationShape)).returns(M.promise()),
  getConfiguration: M.call().returns({
    feeIssuerConfig: {
      name: M.string(),
      assetKind: 'nat',
      displayInfo: DisplayInfoShape,
    },
  }),
  getInvitationDetails: M.call(M.eref(InvitationShape)).returns(M.any()),
  getProposalShapeForInvitation: M.call(InvitationHandleShape).returns(
    M.opt(ProposalShape),
  ),
});

export const AdminFacetI = M.interface('ZcfAdminFacet', {
  getVatShutdownPromise: M.call().returns(M.promise()),
  restartContract: M.call().optional(M.any()).returns(M.promise()),
  upgradeContract: M.call(M.string()).optional(M.any()).returns(M.promise()),
});

export const SeatDataShape = M.splitRecord(
  {
    proposal: ProposalShape,
    initialAllocation: AmountKeywordRecordShape,
    seatHandle: SeatShape,
  },
  {
    offerArgs: M.any(),
  },
);

export const HandleOfferI = M.interface('HandleOffer', {
  handleOffer: M.call(InvitationHandleShape, SeatDataShape).returns({
    offerResultPromise: M.promise(),
    exitObj: ExitObjectShape,
  }),
});

export const PriceQuoteShape = harden({
  quoteAmount: AmountShape,
  quotePayment: M.eref(PaymentShape),
});
