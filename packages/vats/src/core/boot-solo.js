// @ts-check
import { makeBootstrap } from './lib-boot.js';

import * as basicBehaviorsPlus from './basic-behaviors.js';
import * as chainBehaviorsPlus from './chain-behaviors.js';
import { CLIENT_BOOTSTRAP_MANIFEST } from './client-behaviors.js';
import * as clientBehaviorsPlus from './client-behaviors.js';
import * as utils from './utils.js';

export const MANIFEST = CLIENT_BOOTSTRAP_MANIFEST;

// XXX export basicBehaviors record from basic-behaviors.js?
const {
  BASIC_BOOTSTRAP_PERMITS: _5,
  PowerFlags: _3,
  makeMyAddressNameAdminKit: _4,
  ...basicBehaviors
} = basicBehaviorsPlus;
const {
  CHAIN_BOOTSTRAP_MANIFEST: _,
  SHARED_CHAIN_BOOTSTRAP_MANIFEST: _2,
  ...chainBehaviors
} = chainBehaviorsPlus;
const { CLIENT_BOOTSTRAP_MANIFEST: _7, ...clientBehaviors } =
  clientBehaviorsPlus;
const behaviors = harden({
  ...basicBehaviors,
  ...chainBehaviors,
  ...clientBehaviors,
});

const modules = harden({
  clientBehaviors: { ...clientBehaviors },
  behaviors: { ...behaviors },
  utils: { ...utils },
});

/**
 * Build root object of the bootstrap vat.
 *
 * @param {{
 *   D: DProxy,
 *   logger: (msg) => void,
 * }} vatPowers
 * @param {{
 *   argv: { ROLE: string },
 *   bootstrapManifest?: Record<string, Record<string, unknown>>,
 *   coreProposalCode?: string,
 * }} vatParameters
 */
export const buildRootObject = (vatPowers, vatParameters) => {
  console.debug(`solo client bootstrap starting`);

  return makeBootstrap(vatPowers, vatParameters, MANIFEST, behaviors, modules);
};

harden({ buildRootObject });
