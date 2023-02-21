import { E, Far } from '@endo/far';
import {
  makeAgoricNamesAccess,
  makePromiseSpace,
  runModuleBehaviors,
} from './utils.js';

const { quote: q } = assert;

export const makeBootstrap = (
  vatPowers,
  vatParameters,
  bootManifest,
  behaviors,
  modules,
) => {
  const log = vatPowers.logger || console.info;
  const { produce, consume } = makePromiseSpace(log);
  const { agoricNames, agoricNamesAdmin, spaces } = makeAgoricNamesAccess(log);
  produce.agoricNames.resolve(agoricNames);
  produce.agoricNamesAdmin.resolve(agoricNamesAdmin);

  /**
   * Bootstrap vats and devices.
   *
   * @param {SwingsetVats} vats
   * @param {SoloDevices | ChainDevices} devices
   */
  const rawBootstrap = async (vats, devices) => {
    // Complete SwingSet wiring.
    const { D } = vatPowers;
    D(devices.mailbox).registerInboundHandler(vats.vattp);
    await E(vats.vattp).registerMailboxDevice(devices.mailbox);

    const runBehaviors = manifest => {
      return runModuleBehaviors({
        // eslint-disable-next-line no-use-before-define
        allPowers,
        behaviors,
        manifest,
        makeConfig: (name, permit) => {
          log(`bootstrap: ${name}(${q(permit)}`);
          return vatParameters[name];
        },
      });
    };

    // TODO: Aspires to be BootstrapPowers, but it's too specific.
    const allPowers = harden({
      vatPowers,
      vatParameters,
      vats,
      devices,
      produce,
      consume,
      ...spaces,
      runBehaviors,
      // These module namespaces might be useful for core eval governance.
      modules,
    });

    await runBehaviors(bootManifest);

    const { coreProposalCode } = vatParameters;
    if (!coreProposalCode) {
      return;
    }

    // Start the governance from the core proposals.
    const coreEvalMessage = {
      type: 'CORE_EVAL',
      evals: [
        {
          json_permits: 'true',
          js_code: coreProposalCode,
        },
      ],
    };
    /** @type {any} */
    const { coreEvalBridgeHandler } = consume;
    await E(coreEvalBridgeHandler).fromBridge(coreEvalMessage);
  };

  return Far('bootstrap', {
    bootstrap: (vats, devices) =>
      rawBootstrap(vats, devices).catch(e => {
        console.error('BOOTSTRAP FAILED:', e);
        throw e;
      }),
    consumeItem: name => {
      assert.typeof(name, 'string');
      return consume[name];
    },
    produceItem: (name, resolution) => {
      assert.typeof(name, 'string');
      produce[name].resolve(resolution);
    },
    resetItem: name => {
      assert.typeof(name, 'string');
      produce[name].reset();
    },
  });
};
