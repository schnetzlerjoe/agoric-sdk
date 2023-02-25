// @ts-check

import {
  connectFaucet,
  grantRunBehaviors,
  installSimEgress,
} from '@agoric/inter-protocol/src/proposals/sim-behaviors.js';
import { makeBoard } from '../lib-board.js';
import {
  addBankAssets,
  buildZoe,
  installBootContracts,
  makeAddressNameHubs,
  makeClientBanks,
  makeOracleBrands,
  makeVatsFromBundles,
  mintInitialSupply,
  startPriceAuthority,
} from './basic-behaviors.js';
import {
  bridgeProvisioner,
  connectChainFaucet,
  makeBridgeManager,
  makeChainStorage,
  makeProvisioner,
  publishAgoricNames,
  setupClientManager,
  setupNetworkProtocols,
  startTimerService,
} from './chain-behaviors.js';
import { startClient } from './client-behaviors.js';

/**
 * @typedef {true | string | { [key: string]: BootstrapManifestPermit }} BootstrapManifestPermit
 */

/**
 * A manifest is an object in which each key is the name of a function to run
 * at bootstrap and the corresponding value is a "permit" describing an
 * attenuation of allPowers that should be provided as its first argument
 * (cf. packages/vats/src/core/boot.js).
 *
 * A permit is either
 * - `true` or a string (both meaning no attenuation, with a string serving
 *   as a grouping label for convenience and diagram generation), or
 * - an object whose keys identify properties to preserve and whose values
 *   are themselves (recursive) permits.
 *
 * @typedef {Record<string, BootstrapManifestPermit>} BootstrapManifest
 */

/** @type {BootstrapManifest} */
const SHARED_CHAIN_BOOTSTRAP_MANIFEST = harden({
  /** @type {BootstrapManifestPermit} */
  bridgeCoreEval: true, // Needs all the powers.
  [makeOracleBrands.name]: {
    oracleBrand: {
      produce: {
        USD: true,
      },
    },
  },
  [startPriceAuthority.name]: {
    consume: { loadCriticalVat: true, client: true },
    produce: {
      priceAuthorityVat: 'priceAuthority',
      priceAuthority: 'priceAuthority',
      priceAuthorityAdmin: 'priceAuthority',
    },
  },
  [makeVatsFromBundles.name]: {
    vats: {
      vatAdmin: 'vatAdmin',
    },
    devices: {
      vatAdmin: true,
    },
    produce: {
      vatAdminSvc: 'vatAdmin',
      loadVat: true,
      loadCriticalVat: true,
      vatStore: true,
    },
  },
  [buildZoe.name]: {
    consume: {
      vatAdminSvc: true,
      loadCriticalVat: true,
      client: true,
    },
    produce: {
      zoe: 'zoe',
      feeMintAccess: 'zoe',
    },
    issuer: { produce: { Invitation: 'zoe' } },
    brand: { produce: { Invitation: 'zoe' } },
  },
  [makeBoard.name]: {
    consume: {
      loadCriticalVat: true,
      client: true,
    },
    produce: {
      board: 'board',
    },
  },
  [makeBridgeManager.name]: {
    consume: { loadCriticalVat: true },
    devices: { bridge: 'kernel' },
    produce: {
      bridgeManager: true,
      provisionBridgeManager: true,
      provisionWalletBridgeManager: true,
      walletBridgeManager: true,
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
  [startTimerService.name]: {
    devices: {
      timer: true,
    },
    vats: {
      timer: 'timer',
    },
    consume: { client: true },
    produce: {
      chainTimerService: 'timer',
    },
    home: { produce: { chainTimerService: 'timer' } },
  },
  [makeChainStorage.name]: {
    consume: { loadCriticalVat: true, bridgeManager: true },
    produce: {
      chainStorage: 'bridge',
    },
  },
  [publishAgoricNames.name]: {
    consume: {
      agoricNamesAdmin: true,
      board: 'board',
      chainStorage: 'bridge',
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
      // TODO: re-org loadCriticalVat to be subject to permits
      loadCriticalVat: true,
      zoe: true,
    },
    produce: {
      bankManager: 'bank',
      bldIssuerKit: true,
    },
    installation: {
      consume: { centralSupply: 'zoe', mintHolder: 'zoe' },
    },
    issuer: { produce: { BLD: 'BLD', IST: 'zoe' } },
    brand: { produce: { BLD: 'BLD', IST: 'zoe' } },
  },
  [makeProvisioner.name]: {
    consume: {
      loadCriticalVat: true,
      clientCreator: true,
    },
    produce: {
      provisioning: 'provisioning',
    },
    vats: {
      comms: true,
      vattp: true,
    },
  },
  [bridgeProvisioner.name]: {
    consume: {
      provisioning: true,
      bridgeManager: true,
      provisionBridgeManager: true,
      provisionWalletBridgeManager: true,
    },
  },
  [setupClientManager.name]: {
    produce: {
      client: true,
      clientCreator: true,
    },
  },
  [setupNetworkProtocols.name]: {
    consume: {
      client: true,
      loadCriticalVat: true,
      bridgeManager: true,
      zoe: true,
      provisioning: true,
    },
    produce: {
      networkVat: true,
    },
  },
});

/** @type {BootstrapManifest} */
export const CHAIN_BOOTSTRAP_MANIFEST = harden({
  ...SHARED_CHAIN_BOOTSTRAP_MANIFEST,
  [connectChainFaucet.name]: {
    consume: {
      client: true,
    },
    home: { produce: { faucet: true } },
  },
});

/** @type {BootstrapManifest} */
export const CLIENT_BOOTSTRAP_MANIFEST = harden({
  /** @type {BootstrapManifestPermit} */
  [makeVatsFromBundles.name]: {
    vats: {
      vatAdmin: 'vatAdmin',
    },
    devices: {
      vatAdmin: true,
    },
    produce: {
      vatAdminSvc: 'vatAdmin',
      loadVat: true,
      loadCriticalVat: true,
      vatStore: true,
    },
  },
  [startClient.name]: {
    vatParameters: {
      argv: { FIXME_GCI: true },
    },
    devices: { command: true, plugin: true, timer: true },
    vats: {
      comms: true,
      http: true,
      network: true,
      spawner: true,
      timer: true,
      uploads: true,
      vattp: true,
    },
    vatPowers: true,
    consume: { vatAdminSvc: true },
  },
});

/** @type {BootstrapManifest} */
export const SIM_CHAIN_BOOTSTRAP_MANIFEST = harden({
  ...SHARED_CHAIN_BOOTSTRAP_MANIFEST,
  /** @type {BootstrapManifestPermit} */
  [installSimEgress.name]: {
    vatParameters: { argv: { hardcodedClientAddresses: true } },
    vats: {
      vattp: true,
      comms: true,
    },
    consume: { clientCreator: true },
  },
  [connectFaucet.name]: {
    consume: {
      bankManager: true,
      bldIssuerKit: true,
      client: true,
      feeMintAccess: true,
      loadVat: true,
      zoe: true,
    },
    installation: {
      consume: { centralSupply: 'zoe' },
    },
    produce: { mints: true },
    home: { produce: { faucet: true } },
  },
  [grantRunBehaviors.name]: {
    runBehaviors: true,
    consume: { client: true },
    home: { produce: { runBehaviors: true, governanceActions: true } },
  },
});
