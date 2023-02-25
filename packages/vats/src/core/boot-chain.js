// @ts-check
import { makeBootstrap } from './lib-boot.js';

import * as basicBehaviorsPlus from './basic-behaviors.js';
import { CHAIN_BOOTSTRAP_MANIFEST } from './chain-behaviors.js';
import * as chainBehaviorsPlus from './chain-behaviors.js';
import * as utils from './utils.js';

export const MANIFEST = CHAIN_BOOTSTRAP_MANIFEST;

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
const behaviors = { ...basicBehaviors, ...chainBehaviors };

const modules = {
  behaviors: { ...behaviors },
  utils: { ...utils },
};

/**
 * Build root object of the bootstrap vat.
 *
 * @param {{
 *   D: DProxy,
 *   logger: (msg) => void,
 * }} vatPowers
 * @param {{
 *   coreProposalCode?: string,
 * }} vatParameters
 */
export const buildRootObject = (vatPowers, vatParameters) => {
  console.debug(`chain bootstrap starting`);

  return makeBootstrap(vatPowers, vatParameters, MANIFEST, behaviors, modules);
};

harden({ buildRootObject });
