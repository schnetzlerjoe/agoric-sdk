/* global globalThis */
// @ts-check
import { E, Far } from '@endo/far';
import * as farExports from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import {
  makeNotifierKit,
  makeStoredPublishKit,
  makeSubscriptionKit,
  observeIteration,
} from '@agoric/notifier';
import {
  makeLoopbackProtocolHandler,
  makeEchoConnectionHandler,
  makeNonceMaker,
} from '@agoric/swingset-vat/src/vats/network/index.js';
import { importBundle } from '@endo/import-bundle';
import { allValues, BridgeId as BRIDGE_ID } from '@agoric/internal';
import * as STORAGE_PATH from '@agoric/internal/src/chain-storage-paths.js';

import { agoricNamesReserved, callProperties, extractPowers } from './utils.js';
import { PowerFlags, BASIC_BOOTSTRAP_PERMITS } from './basic-behaviors.js';

const { Fail } = assert;
const { keys } = Object;

const NUM_IBC_PORTS_PER_CLIENT = 3;
const INTERCHAIN_ACCOUNT_CONTROLLER_PORT_PREFIX = 'icacontroller-';

/**
 * This registers the code triggered by `agd tx gov submit-proposal
 * swingset-core-eval permit.json code.js`.  It is the "big hammer" governance
 * that allows code.js access to all powers permitted by permit.json.
 *
 * @param {BootstrapPowers} allPowers
 */
export const bridgeCoreEval = async allPowers => {
  // We need all of the powers to be available to the evaluator, but we only
  // need the bridgeManager to install our handler.
  const {
    vatPowers: { D },
    consume: { bridgeManager: bridgeManagerP },
    produce: { coreEvalBridgeHandler },
  } = allPowers;

  const endowments = {
    VatData: globalThis.VatData,
    console,
    assert,
    Base64: globalThis.Base64, // Present only on XSnap
    URL: globalThis.URL, // Absent only on XSnap
  };

  /** @param {BundleCap} bundleCap */
  const evaluateBundleCap = async bundleCap => {
    const bundle = await D(bundleCap).getBundle();
    const imported = await importBundle(bundle, { endowments });
    return imported;
  };
  harden(evaluateBundleCap);

  // Register a coreEval handler over the bridge.
  const handler = Far('coreHandler', {
    async fromBridge(obj) {
      switch (obj.type) {
        case 'CORE_EVAL': {
          /**
           * Type defined by `agoric-sdk/golang/cosmos/proto/agoric/swingset/swingset.proto` CoreEval.
           *
           * @type {{ evals: { json_permits: string, js_code: string }[]}}
           */
          const { evals } = obj;
          return Promise.all(
            evals.map(({ json_permits: jsonPermit, js_code: code }) =>
              // Run in a new turn to avoid crosstalk of the evaluations.
              Promise.resolve()
                .then(() => {
                  const permit = JSON.parse(jsonPermit);
                  const powers = extractPowers(permit, {
                    evaluateBundleCap,
                    ...allPowers,
                  });

                  // Inspired by ../repl.js:
                  const globals = harden({
                    ...allPowers.modules,
                    ...farExports,
                    ...endowments,
                  });

                  // Evaluate the code in the context of the globals.
                  const compartment = new Compartment(globals);
                  harden(compartment.globalThis);
                  const behavior = compartment.evaluate(code);
                  return behavior(powers);
                })
                .catch(err => {
                  console.error('CORE_EVAL failed:', err);
                  throw err;
                }),
            ),
          ).then(_ => {});
        }
        default: {
          throw Fail`Unrecognized request ${obj.type}`;
        }
      }
    },
  });
  coreEvalBridgeHandler.resolve(handler);

  const bridgeManager = await bridgeManagerP;
  if (!bridgeManager) {
    // Not running with a bridge.
    return;
  }
  await E(bridgeManager).register(BRIDGE_ID.CORE, handler);
};
harden(bridgeCoreEval);

/**
 * @param {BootstrapPowers & {
 *   namedVat: PromiseSpaceOf<{ provisioning: Awaited<ProvisioningVat>}>
 * }} powers
 */
export const makeProvisioner = async ({
  consume: { clientCreator },
  vats: { comms, vattp },
  namedVat: {
    consume: { provisioning: provisionerVat },
  },
}) => {
  await E(provisionerVat).register(clientCreator, comms, vattp);
};
harden(makeProvisioner);

/**
 * @param {BootstrapPowers} powers
 */
export const noProvisioner = async ({ produce: { provisioning } }) => {
  provisioning.resolve(undefined);
};
harden(noProvisioner);

/** @param {BootstrapPowers} powers */
export const bridgeProvisioner = async ({
  consume: {
    provisioning: provisioningP,
    provisionBridgeManager: provisionBridgeManagerP,
    provisionWalletBridgeManager: provisionWalletBridgeManagerP,
  },
}) => {
  const [provisioning, provisionBridgeManager, provisionWalletBridgeManager] =
    await Promise.all([
      provisioningP,
      provisionBridgeManagerP,
      provisionWalletBridgeManagerP,
    ]);
  if (!provisionBridgeManager || !provisionWalletBridgeManager) {
    return;
  }

  // Register a provisioning handler over the bridge.
  const handler = provisioning
    ? Far('provisioningHandler', {
        async fromBridge(obj) {
          switch (obj.type) {
            case 'PLEASE_PROVISION': {
              const { nickname, address, powerFlags: rawPowerFlags } = obj;
              const powerFlags = rawPowerFlags || [];
              let provisionP;
              if (powerFlags.includes(PowerFlags.SMART_WALLET)) {
                // Only provision a smart wallet.
                provisionP = E(provisionWalletBridgeManager).fromBridge(obj);
              } else {
                // Provision a mailbox and REPL.
                provisionP = E(provisioning).pleaseProvision(
                  nickname,
                  address,
                  powerFlags,
                );
              }
              return provisionP
                .catch(e =>
                  console.error(
                    `Error provisioning ${nickname} ${address}:`,
                    e,
                  ),
                )
                .then(_ => {});
            }
            default: {
              throw Fail`Unrecognized request ${obj.type}`;
            }
          }
        },
      })
    : provisionWalletBridgeManager;
  await E(provisionBridgeManager).setHandler(handler);
};
harden(bridgeProvisioner);

/**
 * @param {Record<string, unknown>} pattern
 * @param {Record<string, unknown>} specimen
 */
const missingKeys = (pattern, specimen) =>
  keys(pattern).filter(k => !keys(specimen).includes(k));

/**
 * @param {BootstrapSpace} powers
 * @param {{ template?: Record<string, unknown> }} config
 */
export const setupClientManager = async (
  { produce: { client, clientCreator: clientCreatorP } },
  {
    template = {
      agoricNames: true,
      bank: true,
      namesByAddress: true,
      myAddressNameAdmin: true,
      board: true,
      faucet: true,
      zoe: true,
    },
  } = {},
) => {
  // Create a subscription of chain configurations.
  /** @type {SubscriptionRecord<PropertyMaker[]>} */
  const { subscription, publication } = makeSubscriptionKit();

  /** @type {ClientManager} */
  const clientManager = Far('chainClientManager', {
    assignBundle: newPropertyMakers => {
      // Write the property makers to the cache, and update the subscription.
      publication.updateState(newPropertyMakers);
    },
  });

  /** @type {ClientCreator} */
  const clientCreator = Far('clientCreator', {
    createUserBundle: (nickname, clientAddress, powerFlags) => {
      const c = E(clientCreator).createClientFacet(
        nickname,
        clientAddress,
        powerFlags,
      );
      return E(c).getChainBundle();
    },
    createClientFacet: async (_nickname, clientAddress, powerFlags) => {
      /** @type {Record<string, unknown>} */
      let clientHome = {};
      const bundleReady = makePromiseKit();

      const makeUpdatedConfiguration = async (newPropertyMakers = []) => {
        // Specialize the property makers with the client address.
        const newProperties = callProperties(
          newPropertyMakers,
          clientAddress,
          powerFlags,
        );
        clientHome = { ...clientHome, ...newProperties };

        const todo = missingKeys(template, clientHome);
        if (todo.length === 0) {
          bundleReady.resolve(undefined);
        }

        return harden({ clientAddress, clientHome });
      };

      // Publish new configurations.
      const newConfig = await makeUpdatedConfiguration([]);
      const { notifier, updater } = makeNotifierKit(newConfig);

      /** @type {ClientFacet} */
      const clientFacet = Far('chainProvisioner', {
        getChainBundle: () =>
          bundleReady.promise.then(_ => allValues(clientHome)),
        getConfiguration: () => notifier,
      });

      observeIteration(subscription, {
        updateState(newPropertyMakers) {
          makeUpdatedConfiguration(newPropertyMakers)
            .then(x => updater.updateState(x))
            .catch(reason => console.error(reason)); // TODO: catch and log OK?
        },
      });

      return clientFacet;
    },
  });

  clientCreatorP.resolve(clientCreator);
  client.resolve(clientManager);
};
harden(setupClientManager);

/** @param {BootstrapPowers} powers */
export const startTimerService = async ({
  devices: { timer: timerDevice },
  vats: { timer: timerVat },
  consume: { client },
  produce: { chainTimerService: produceTimer },
}) => {
  const chainTimerService = E(timerVat).createTimerService(timerDevice);
  produceTimer.resolve(chainTimerService);
  return E(client).assignBundle([_addr => ({ chainTimerService })]);
};
harden(startTimerService);

/**
 * @param {BootDevices<ChainDevices> & BootstrapSpace & {
 *   namedVat: PromiseSpaceOf<{ chainStorage: Awaited<ChainStorageVat>}>
 * }} powers
 */
export const makeBridgeManager = async ({
  devices: { bridge },
  produce: {
    bridgeManager: bridgeManagerP,
    provisionBridgeManager,
    provisionWalletBridgeManager,
    walletBridgeManager,
  },
  namedVat,
}) => {
  if (!bridge) {
    console.warn(
      'Running without a bridge device; this is not an actual chain.',
    );
    bridgeManagerP.resolve(undefined);
    provisionBridgeManager.resolve(undefined);
    provisionWalletBridgeManager.resolve(undefined);
    walletBridgeManager.resolve(undefined);
    return;
  }
  const vat = namedVat.consume.chainStorage;
  const bridgeManager = E(vat).provideManagerForBridge(bridge);
  bridgeManagerP.resolve(bridgeManager);
  provisionBridgeManager.resolve(
    E(bridgeManager).register(BRIDGE_ID.PROVISION),
  );
  provisionWalletBridgeManager.resolve(
    E(bridgeManager).register(BRIDGE_ID.PROVISION_SMART_WALLET),
  );
  walletBridgeManager.resolve(E(bridgeManager).register(BRIDGE_ID.WALLET));
};
harden(makeBridgeManager);

/**
 * @param {BootstrapSpace & {
 *   namedVat: PromiseSpaceOf<{ chainStorage: Awaited<ChainStorageVat>}>
 * }} powers
 */
export const makeChainStorage = async ({
  consume: { bridgeManager: bridgeManagerP },
  produce: { chainStorage: chainStorageP },
  namedVat,
}) => {
  const bridgeManager = await bridgeManagerP;
  if (!bridgeManager) {
    console.warn('Cannot support chainStorage without an actual chain.');
    chainStorageP.resolve(null);
    return;
  }

  const ROOT_PATH = STORAGE_PATH.CUSTOM;

  const storageBridgeManager = E(bridgeManager).register(BRIDGE_ID.STORAGE);

  const vat = namedVat.consume.chainStorage;
  const rootNodeP = E(vat).makeBridgedChainStorageRoot(
    storageBridgeManager,
    ROOT_PATH,
    { sequence: true },
  );
  chainStorageP.resolve(rootNodeP);
};

/**
 * @param {BootstrapPowers} powers
 * @param {{ options?: {agoricNamesOptions?: {
 *   topLevel?: string[]
 * }}}} config
 */
export const publishAgoricNames = async (
  { consume: { agoricNamesAdmin, board, chainStorage: rootP } },
  { options: { agoricNamesOptions } = {} } = {},
) => {
  const root = await rootP;
  if (!root) {
    console.warn('cannot publish agoricNames without chainStorage');
    return;
  }
  const nameStorage = E(root).makeChildNode('agoricNames');
  const marshaller = E(board).getPublishingMarshaller();

  // brand, issuer, ...
  const { topLevel = keys(agoricNamesReserved) } = agoricNamesOptions || {};
  await Promise.all(
    topLevel.map(async kind => {
      const kindAdmin = await E(agoricNamesAdmin).lookupAdmin(kind);

      const kindNode = await E(nameStorage).makeChildNode(kind);
      const { publisher } = makeStoredPublishKit(kindNode, marshaller);
      publisher.publish([]);
      kindAdmin.onUpdate(publisher.publish);
    }),
  );
};

/**
 * no free lunch on chain
 *
 * @param {BootstrapPowers} powers
 */
export const connectChainFaucet = async ({ consume: { client } }) => {
  const faucet = Far('faucet', { tapFaucet: () => harden([]) });

  return E(client).assignBundle([_addr => ({ faucet })]);
};
harden(connectChainFaucet);

/**
 * @param {SoloVats | NetVats} vats
 * @param {ERef<import('../types.js').ScopedBridgeManager>} [dibcBridgeManager]
 */
export const registerNetworkProtocols = async (vats, dibcBridgeManager) => {
  const ps = [];
  // Every vat has a loopback device.
  ps.push(
    E(vats.network).registerProtocolHandler(
      ['/local'],
      makeLoopbackProtocolHandler(),
    ),
  );
  if (dibcBridgeManager) {
    assert('ibc' in vats);
    // We have access to the bridge, and therefore IBC.
    const callbacks = Far('callbacks', {
      downcall(method, obj) {
        return E(dibcBridgeManager).toBridge({
          ...obj,
          type: 'IBC_METHOD',
          method,
        });
      },
    });
    ps.push(
      E(vats.ibc)
        .createInstance(callbacks)
        .then(ibcHandler =>
          E(dibcBridgeManager)
            .setHandler(ibcHandler)
            .then(() =>
              E(vats.network).registerProtocolHandler(
                ['/ibc-port', '/ibc-hop'],
                ibcHandler,
              ),
            ),
        ),
    );
  } else {
    const loHandler = makeLoopbackProtocolHandler(
      makeNonceMaker('ibc-channel/channel-'),
    );
    ps.push(E(vats.network).registerProtocolHandler(['/ibc-port'], loHandler));
  }
  await Promise.all(ps);

  // Add an echo listener on our ibc-port network (whether real or virtual).
  const echoPort = await E(vats.network).bind('/ibc-port/echo');

  return E(echoPort).addListener(
    Far('listener', {
      async onAccept(_port, _localAddr, _remoteAddr, _listenHandler) {
        return harden(makeEchoConnectionHandler());
      },
      async onListen(port, _listenHandler) {
        console.debug(`listening on echo port: ${port}`);
      },
    }),
  );
};

/**
 * @param { BootstrapPowers &
 *  { namedVat: PromiseSpaceOf<NetVats> } &
 *  { produce: { networkVat: Producer<any> } }
 * } powers
 *
 * @typedef {{ network: Awaited<NetworkVat>, ibc: Awaited<IBCVat>, provisioning: Awaited<ProvisioningVat | undefined>}} NetVats
 */
export const setupNetworkProtocols = async ({
  consume: { client, bridgeManager: bridgeManagerP },
  namedVat,
  produce: { networkVat },
}) => {
  const vats = namedVat.consume;
  // don't proceed if loadCriticalVat fails
  await Promise.all(Object.values(vats));

  networkVat.reset();
  networkVat.resolve(vats.network);
  const bridgeManager = await bridgeManagerP;
  const dibcBridgeManager =
    bridgeManager && E(bridgeManager).register(BRIDGE_ID.DIBC);

  // The Interchain Account (ICA) Controller must be bound to a port that starts
  // with 'icacontroller', so we provide one such port to each client.
  let lastICAPort = 0;
  const makePorts = async () => {
    // Bind to some fresh ports (either unspecified name or `icacontroller-*`)
    // on the IBC implementation and provide them for the user to have.
    const ibcportP = [];
    for (let i = 0; i < NUM_IBC_PORTS_PER_CLIENT; i += 1) {
      let bindAddr = '/ibc-port/';
      if (i === NUM_IBC_PORTS_PER_CLIENT - 1) {
        lastICAPort += 1;
        bindAddr += `${INTERCHAIN_ACCOUNT_CONTROLLER_PORT_PREFIX}-${lastICAPort}`;
      }
      const port = E(vats.network).bind(bindAddr);
      ibcportP.push(port);
    }
    return Promise.all(ibcportP);
  };

  // Note: before we add the pegasus transfer port,
  // we need to finish registering handlers for
  // ibc-port etc.
  await registerNetworkProtocols(vats, dibcBridgeManager);
  return E(client).assignBundle([_a => ({ ibcport: makePorts() })]);
};

/** @type {import('./lib-boot').BootstrapManifest} */
export const SHARED_CHAIN_BOOTSTRAP_MANIFEST = harden({
  /** @type {import('./lib-boot').BootstrapManifestPermit} */
  bridgeCoreEval: true, // Needs all the powers.
  ...BASIC_BOOTSTRAP_PERMITS,

  [makeBridgeManager.name]: {
    devices: { bridge: 'kernel' },
    produce: {
      bridgeManager: true,
      provisionBridgeManager: true,
      provisionWalletBridgeManager: true,
      walletBridgeManager: true,
    },
    namedVat: { consume: { chainStorage: 'chainStorage' } },
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
    consume: { bridgeManager: true },
    produce: {
      chainStorage: 'chainStorage',
    },
    namedVat: {
      chainStorage: 'chainStorage',
    },
  },
  [publishAgoricNames.name]: {
    consume: {
      agoricNamesAdmin: true,
      board: 'board',
      chainStorage: 'chainStorage',
    },
  },
  [makeProvisioner.name]: {
    consume: {
      clientCreator: true,
    },
    vats: {
      comms: true,
      vattp: true,
    },
    namedVat: {
      consume: { provisioning: 'provisioning' },
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
      bridgeManager: true,
      zoe: true,
      provisioning: true,
    },
    produce: {
      networkVat: true,
    },
    namedVat: {
      consume: {
        network: 'network',
        ibc: 'ibc',
        provisioning: 'provisioning',
      },
    },
  },
});

/** @type {import('./lib-boot.js').BootstrapManifest} */
export const CHAIN_BOOTSTRAP_MANIFEST = harden({
  ...SHARED_CHAIN_BOOTSTRAP_MANIFEST,
  [connectChainFaucet.name]: {
    consume: {
      client: true,
    },
    home: { produce: { faucet: true } },
  },
});
