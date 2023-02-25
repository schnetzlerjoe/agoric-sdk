// @ts-check

import { Nat } from '@endo/nat';
import { E, Far } from '@endo/far';
import { AssetKind, makeIssuerKit } from '@agoric/ertp';
import { BridgeId, WalletName } from '@agoric/internal';

import { makeNameHubKit } from '../nameHub.js';
import { feeIssuerConfig } from './utils.js';
import { Stable, Stake } from '../tokens.js';

const { details: X } = assert;

// These two are inextricably linked with ../../golang/cosmos.
const RESERVE_MODULE_ACCOUNT = 'vbank/reserve';
const RESERVE_ADDRESS = 'agoric1ae0lmtzlgrcnla9xjkpaarq5d5dfez63h3nucl';

// XXX domain of @agoric/cosmic-proto
/**
 * non-exhaustive list of powerFlags
 * REMOTE_WALLET is currently a default.
 *
 * See also MsgProvision in golang/cosmos/proto/agoric/swingset/msgs.proto
 */
export const PowerFlags = /** @type {const} */ ({
  SMART_WALLET: 'SMART_WALLET',
  /** The ag-solo wallet is remote. */
  REMOTE_WALLET: 'REMOTE_WALLET',
});

/**
 * In golang/cosmos/app/app.go, we define
 * cosmosInitAction with type AG_COSMOS_INIT,
 * with the following shape.
 *
 * The uist supplyCoins value is taken from genesis,
 * thereby authorizing the minting an initial supply of RUN.
 */
// eslint-disable-next-line no-unused-vars
const bootMsgEx = {
  type: 'AG_COSMOS_INIT',
  chainID: 'agoric',
  storagePort: 1,
  supplyCoins: [
    { denom: 'provisionpass', amount: '100' },
    { denom: 'sendpacketpass', amount: '100' },
    { denom: 'ubld', amount: '1000000000000000' },
    { denom: 'uist', amount: '50000000000' },
  ],
  vbankPort: 3,
  vibcPort: 2,
};

/**
 * TODO: review behaviors carefully for powers that go out of scope,
 * since we may want/need them later.
 */

/**
 * @param { BootstrapPowers & { namedVat: PromiseSpaceOf<{
 *   zoe: ZoeVat,
 * }> } } powers
 *
 * @typedef {ERef<ReturnType<import('../vat-zoe.js').buildRootObject>>} ZoeVat
 */
export const buildZoe = async ({
  consume: { vatAdminSvc, client },
  produce: { zoe, feeMintAccess },
  namedVat: {
    consume: { zoe: zoeVatRoot },
  },
  brand: {
    produce: { Invitation: invitationBrand },
  },
  issuer: {
    produce: { Invitation: invitationIssuer },
  },
}) => {
  const zcfBundleName = 'zcf'; // should match config.bundles.zcf=
  const { zoeService, feeMintAccess: fma } = await E(zoeVatRoot).buildZoe(
    vatAdminSvc,
    feeIssuerConfig,
    zcfBundleName,
  );

  zoe.resolve(zoeService);
  const issuer = E(zoeService).getInvitationIssuer();
  const brand = E(issuer).getBrand();
  invitationIssuer.resolve(issuer);
  invitationBrand.resolve(brand);

  feeMintAccess.resolve(fma);
  await Promise.all([E(client).assignBundle([_addr => ({ zoe: zoeService })])]);
};
harden(buildZoe);

/**
 * @param {BootstrapPowers & {
 *   namedVat: PromiseSpaceOf<{ priceAuthority: PriceAuthorityVat }>
 * }} powers
 *
 * @typedef {ERef<ReturnType<import('../vat-priceAuthority.js').buildRootObject>>} PriceAuthorityVat
 */
export const startPriceAuthority = async ({
  consume: { client },
  produce,
  namedVat: {
    consume: { priceAuthority: priceAuthorityRoot },
  },
}) => {
  const { priceAuthority, adminFacet } = await E(
    priceAuthorityRoot,
  ).makePriceAuthorityRegistry();

  produce.priceAuthorityVat.resolve(priceAuthorityRoot);
  produce.priceAuthority.resolve(priceAuthority);
  produce.priceAuthorityAdmin.resolve(adminFacet);

  return E(client).assignBundle([_addr => ({ priceAuthority })]);
};
harden(startPriceAuthority);

/**
 * Create inert brands (no mint or issuer) referred to by price oracles.
 *
 * @param {BootstrapPowers} powers
 */
export const makeOracleBrands = async ({
  oracleBrand: { produce: oracleBrandProduce },
}) => {
  const { brand } = makeIssuerKit(
    'USD',
    AssetKind.NAT,
    harden({ decimalPlaces: 6 }),
  );
  oracleBrandProduce.USD.resolve(brand);
};
harden(makeOracleBrands);

/**
 * TODO: rename this to getBoard?
 *
 * @param {BootstrapPowers & {
 *   namedVat: PromiseSpaceOf<{ board: BoardVat}>
 * }} powers
 * @typedef {ERef<ReturnType<import('../vat-board.js').buildRootObject>>} BoardVat
 */
export const makeBoard = async ({
  consume: { client },
  produce: {
    board: { resolve: resolveBoard },
  },
  namedVat: {
    consume: { board: boardRoot },
  },
}) => {
  const board = await E(boardRoot).getBoard();
  resolveBoard(board);
  return E(client).assignBundle([_addr => ({ board })]);
};
harden(makeBoard);

/**
 * @param {string} address
 */
export const makeMyAddressNameAdminKit = address => {
  // Create a name hub for this address.
  const { nameHub, nameAdmin: rawMyAddressNameAdmin } = makeNameHubKit();

  /** @type {import('../types').MyAddressNameAdmin} */
  const myAddressNameAdmin = Far('myAddressNameAdmin', {
    ...rawMyAddressNameAdmin,
    getMyAddress: () => address,
  });
  // reserve space for deposit facet
  myAddressNameAdmin.reserve(WalletName.depositFacet);

  return { nameHub, myAddressNameAdmin };
};

/**
 * Make the agoricNames, namesByAddress name hierarchies.
 *
 * agoricNames are well-known items such as the IST issuer,
 * available as E(home.agoricNames).lookup('issuer', 'IST')
 *
 * namesByAddress is a NameHub for each provisioned client,
 * available, for example, as `E(home.namesByAddress).lookup('agoric1...')`.
 * `depositFacet` as in `E(home.namesByAddress).lookup('agoric1...', 'depositFacet')`
 * is reserved for use by the Agoric wallet. Each client
 * is given `home.myAddressNameAdmin`, which they can use to
 * assign (update / reserve) any other names they choose.
 *
 * @param {BootstrapSpace} powers
 */
export const makeAddressNameHubs = async ({
  consume: { agoricNames: agoricNamesP, client },
  produce,
}) => {
  const agoricNames = await agoricNamesP;

  const { nameHub: namesByAddress, nameAdmin: namesByAddressAdmin } =
    makeNameHubKit();
  produce.namesByAddress.resolve(namesByAddress);
  produce.namesByAddressAdmin.resolve(namesByAddressAdmin);

  const perAddress = address => {
    const { nameHub, myAddressNameAdmin } = makeMyAddressNameAdminKit(address);
    myAddressNameAdmin.reserve(WalletName.depositFacet);

    // This may race against walletFactory.js/publishDepositFacet, so we are
    // careful not to clobber the first nameHub that is used to update
    // namesByAddressAdmin.
    namesByAddressAdmin.default(address, nameHub, myAddressNameAdmin);

    const actualAdmin = namesByAddressAdmin.lookupAdmin(address);
    return { agoricNames, namesByAddress, myAddressNameAdmin: actualAdmin };
  };

  return E(client).assignBundle([perAddress]);
};
harden(makeAddressNameHubs);

/** @param {BootstrapSpace} powers */
export const makeClientBanks = async ({
  consume: {
    namesByAddressAdmin,
    client,
    bankManager,
    walletFactoryStartResult,
  },
}) => {
  const walletFactoryCreatorFacet = E.get(
    walletFactoryStartResult,
  ).creatorFacet;
  return E(client).assignBundle([
    (address, powerFlags) => {
      const bank = E(bankManager).getBankForAddress(address);
      if (!powerFlags.includes(PowerFlags.SMART_WALLET)) {
        return { bank };
      }
      assert(
        !powerFlags.includes(PowerFlags.REMOTE_WALLET),
        `REMOTE and SMART_WALLET are exclusive`,
      );
      /** @type {ERef<import('../types').MyAddressNameAdmin>} */
      const myAddressNameAdmin = E(namesByAddressAdmin).lookupAdmin(address);

      const smartWallet = E(walletFactoryCreatorFacet).provideSmartWallet(
        address,
        bank,
        myAddressNameAdmin,
      );

      // sets these values in REPL home by way of registerWallet
      return { bank, smartWallet };
    },
  ]);
};
harden(makeClientBanks);

/** @param {BootstrapSpace} powers */
export const installBootContracts = async ({
  consume: { vatAdminSvc, zoe },
  installation: {
    produce: { centralSupply, mintHolder },
  },
}) => {
  for (const [name, producer] of Object.entries({
    centralSupply,
    mintHolder,
  })) {
    const idP = E(vatAdminSvc).getBundleIDByName(name);
    const installationP = idP.then(bundleID =>
      E(zoe).installBundleID(bundleID),
    );
    producer.resolve(installationP);
  }
};

/**
 * Mint IST genesis supply.
 *
 * @param { BootstrapPowers & {
 *   vatParameters: { argv: { bootMsg?: typeof bootMsgEx }},
 * }} powers
 */
export const mintInitialSupply = async ({
  vatParameters: {
    argv: { bootMsg },
  },
  consume: { feeMintAccess: feeMintAccessP, zoe },
  produce: { initialSupply },
  installation: {
    consume: { centralSupply },
  },
}) => {
  const feeMintAccess = await feeMintAccessP;

  const { supplyCoins = [] } = bootMsg || {};
  const centralBootstrapSupply = supplyCoins.find(
    ({ denom }) => denom === Stable.denom,
  ) || { amount: '0' };
  const bootstrapPaymentValue = Nat(BigInt(centralBootstrapSupply.amount));

  /** @type {Awaited<ReturnType<typeof import('../centralSupply.js').start>>} */
  const { creatorFacet } = await E(zoe).startInstance(
    centralSupply,
    {},
    { bootstrapPaymentValue },
    { feeMintAccess },
  );
  const payment = E(creatorFacet).getBootstrapPayment();
  // TODO: shut down the centralSupply contract, now that we have the payment?
  initialSupply.resolve(payment);
};
harden(mintInitialSupply);

/**
 * Add IST (with initialSupply payment), BLD (with mint) to BankManager.
 *
 * @param { BootstrapSpace & {
 *   namedVat: PromiseSpaceOf<{ bank: Awaited<BankVat> }>
 * }} powers
 */
export const addBankAssets = async ({
  consume: {
    agoricNamesAdmin,
    initialSupply,
    bridgeManager: bridgeManagerP,
    zoe,
  },
  produce: { bankManager, bldIssuerKit },
  installation: {
    consume: { mintHolder },
  },
  issuer: { produce: produceIssuer },
  brand: { produce: produceBrand },
  namedVat: {
    consume: { bank: bankRoot },
  },
}) => {
  const runIssuer = await E(zoe).getFeeIssuer();
  const [runBrand, payment] = await Promise.all([
    E(runIssuer).getBrand(),
    initialSupply,
  ]);
  const runKit = { issuer: runIssuer, brand: runBrand, payment };

  const { creatorFacet: bldMint, publicFacet: bldIssuer } = E.get(
    E(zoe).startInstance(
      mintHolder,
      harden({}),
      harden({
        keyword: Stake.symbol,
        assetKind: Stake.assetKind,
        displayInfo: Stake.displayInfo,
      }),
    ),
  );
  const bldBrand = await E(bldIssuer).getBrand();
  const bldKit = { mint: bldMint, issuer: bldIssuer, brand: bldBrand };
  bldIssuerKit.resolve(bldKit);

  const assetAdmin = E(agoricNamesAdmin).lookupAdmin('vbankAsset');
  const nameUpdater = Far('AssetHub', {
    update: (name, val) => E(assetAdmin).update(name, val),
  });

  const bridgeManager = await bridgeManagerP;
  const bankBridgeManager =
    bridgeManager && E(bridgeManager).register(BridgeId.BANK);
  const bankMgr = await E(bankRoot).makeBankManager(
    bankBridgeManager,
    nameUpdater,
  );
  bankManager.resolve(bankMgr);

  // Sanity check: the bank manager should have a reserve module account.
  const reserveAddress = await E(bankMgr).getModuleAccountAddress(
    RESERVE_MODULE_ACCOUNT,
  );
  if (reserveAddress !== null) {
    // bridgeManager is available, so we should have a legit reserve address.
    assert.equal(
      reserveAddress,
      RESERVE_ADDRESS,
      X`vbank address for reserve module ${RESERVE_MODULE_ACCOUNT} is ${reserveAddress}; expected ${RESERVE_ADDRESS}`,
    );
  }

  produceIssuer.BLD.resolve(bldKit.issuer);
  produceIssuer.IST.resolve(runKit.issuer);
  produceBrand.BLD.resolve(bldKit.brand);
  produceBrand.IST.resolve(runKit.brand);
  await Promise.all([
    E(bankMgr).addAsset(
      Stake.denom,
      Stake.symbol,
      Stake.proposedName,
      bldKit, // with mint
    ),
    E(bankMgr).addAsset(
      Stable.denom,
      Stable.symbol,
      Stable.proposedName,
      runKit, // without mint, with payment
    ),
  ]);
};
harden(addBankAssets);

/** @type {import('./lib-boot').BootstrapManifest} */
export const BASIC_BOOTSTRAP_PERMITS = harden({
  /** @type {import('./lib-boot').BootstrapManifestPermit} */
  bridgeCoreEval: true, // Needs all the powers.
  [makeOracleBrands.name]: {
    oracleBrand: {
      produce: {
        USD: true,
      },
    },
  },
  [startPriceAuthority.name]: {
    consume: { client: true },
    produce: {
      priceAuthorityVat: 'priceAuthority',
      priceAuthority: 'priceAuthority',
      priceAuthorityAdmin: 'priceAuthority',
    },
    namedVat: {
      consume: { priceAuthority: 'priceAuthority' },
    },
  },
  [buildZoe.name]: {
    consume: {
      vatAdminSvc: true,
      client: true,
    },
    produce: {
      zoe: 'zoe',
      feeMintAccess: 'zoe',
    },
    namedVat: {
      consume: { zoe: 'zoe' },
    },
    issuer: { produce: { Invitation: 'zoe' } },
    brand: { produce: { Invitation: 'zoe' } },
  },
  [makeBoard.name]: {
    consume: {
      client: true,
    },
    produce: {
      board: 'board',
    },
    namedVat: {
      consume: { board: 'board' },
    },
  },

  [makeAddressNameHubs.name]: {
    consume: {
      agoricNames: true,
      client: true,
    },
    produce: {
      namesByAddress: true,
      namesByAddressAdmin: true,
    },
    home: {
      produce: { myAddressNameAdmin: true },
    },
  },
  [makeClientBanks.name]: {
    consume: {
      namesByAddressAdmin: true,
      bankManager: 'bank',
      client: true,
      walletFactoryStartResult: 'walletFactory',
    },
    home: { produce: { bank: 'bank' } },
  },
  [installBootContracts.name]: {
    consume: { zoe: 'zoe', vatAdminSvc: true },
    installation: {
      produce: {
        centralSupply: 'zoe',
        mintHolder: 'zoe',
      },
    },
  },
  [mintInitialSupply.name]: {
    vatParameters: {
      argv: { bootMsg: true },
    },
    consume: {
      feeMintAccess: true,
      zoe: true,
    },
    produce: {
      initialSupply: true,
    },
    installation: {
      consume: { centralSupply: 'zoe' },
    },
  },
  [addBankAssets.name]: {
    consume: {
      agoricNamesAdmin: true,
      initialSupply: true,
      bridgeManager: true,
      zoe: true,
    },
    produce: {
      bankManager: 'bank',
      bldIssuerKit: true,
    },
    namedVat: {
      consume: { bank: 'bank' },
    },
    installation: {
      consume: { centralSupply: 'zoe', mintHolder: 'zoe' },
    },
    issuer: { produce: { BLD: 'BLD', IST: 'zoe' } },
    brand: { produce: { BLD: 'BLD', IST: 'zoe' } },
  },
});
