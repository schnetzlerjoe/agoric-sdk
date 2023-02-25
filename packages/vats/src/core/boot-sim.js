// @ts-check
import { SIM_CHAIN_BOOTSTRAP_PERMITS } from '@agoric/inter-protocol/src/proposals/sim-behaviors.js';
import * as simBehaviorsPlus from '@agoric/inter-protocol/src/proposals/sim-behaviors.js';
import * as basicBehaviorsPlus from './basic-behaviors.js';
import { SHARED_CHAIN_BOOTSTRAP_MANIFEST } from './chain-behaviors.js';
import * as chainBehaviorsPlus from './chain-behaviors.js';
import * as utils from './utils.js';

import { makeBootstrap } from './lib-boot.js';

export const MANIFEST = {
  ...SHARED_CHAIN_BOOTSTRAP_MANIFEST,
  ...SIM_CHAIN_BOOTSTRAP_PERMITS,
};

const {
  BASIC_BOOTSTRAP_PERMITS: _1,
  PowerFlags: _2,
  makeMyAddressNameAdminKit: _3,
  ...basicBehaviors
} = basicBehaviorsPlus;
const {
  CHAIN_BOOTSTRAP_MANIFEST: _4,
  SHARED_CHAIN_BOOTSTRAP_MANIFEST: _5,
  ...chainBehaviors
} = chainBehaviorsPlus;
const { SIM_CHAIN_BOOTSTRAP_PERMITS: _6, ...simBehaviors } = simBehaviorsPlus;
const behaviors = { ...basicBehaviors, ...chainBehaviors, ...simBehaviors };

/**
 * Build root object of the bootstrap vat for the simulated chain.
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
  console.debug(`sim bootstrap starting`);

  const modules = harden({ utils: { ...utils } });
  return makeBootstrap(vatPowers, vatParameters, MANIFEST, behaviors, modules);
};

harden({ buildRootObject });
