/* global process */
import fs from 'fs';
import path from 'path';

import { resolve as resolveModuleSpecifier } from 'import-meta-resolve';
import { assert, Fail, q } from '@agoric/assert';
import { getLockdownBundle } from '@agoric/xsnap-lockdown';
import bundleSource from '@endo/bundle-source';

import '../types-ambient.js';
import { makeTracer } from '@agoric/internal';
import { insistStorageAPI } from '../lib/storageAPI.js';
import { initializeKernel } from './initializeKernel.js';
import { kdebugEnable } from '../lib/kdebug.js';
import { makeNodeBundleCache } from '../../tools/bundleTool.js';

const trace = makeTracer('IniSwi', false);

/**
 * @param {X[]} xs
 * @param {Y[]} ys
 * @returns {[X, Y][]}
 * @template X, Y
 */
const zip = (xs, ys) => xs.map((x, i) => [x, ys[i]]);
const { keys, values, fromEntries } = Object;
/**
 * @param {Record<string, Promise<V>>} obj
 * @returns {Promise<Record<string, V>>}
 * @template V
 */
const allValues = async obj =>
  // eslint-disable-next-line @jessie.js/no-nested-await
  fromEntries(zip(keys(obj), await Promise.all(values(obj))));

const bundleRelative = rel =>
  bundleSource(new URL(rel, import.meta.url).pathname);
const bundleRelativeCallable = rel =>
  bundleSource(new URL(rel, import.meta.url).pathname, {
    format: 'nestedEvaluate',
  });

/**
 * Build the source bundles for the kernel. makeSwingsetController()
 * calls this on each launch, to get the
 * current kernel sources
 */
export async function buildKernelBundle() {
  // this takes about 1.0s on my computer
  const kernelBundle = await bundleRelative('../kernel/kernel.js');
  return harden(kernelBundle);
}

/**
 * Build the source bundles for built-in vats and devices, and for the
 * xsnap vat worker.
 */
export async function buildVatAndDeviceBundles() {
  const lockdownP = getLockdownBundle(); // throws if bundle is not built
  const bundles = await allValues({
    adminDevice: bundleRelative('../devices/vat-admin/device-vat-admin.js'),
    adminVat: bundleRelative('../vats/vat-admin/vat-vat-admin.js'),
    comms: bundleRelative('../vats/comms/index.js'),
    vattp: bundleRelative('../vats/vattp/vat-vattp.js'),
    timer: bundleRelative('../vats/timer/vat-timer.js'),

    lockdown: lockdownP,
    supervisor: bundleRelativeCallable(
      '../supervisors/subprocess-xsnap/supervisor-subprocess-xsnap.js',
    ),
  });

  return harden(bundles);
}

// Unit tests can call this to amortize the bundling costs: pass the
// result to initializeSwingset's initializationOptions.kernelBundles
// (for the vat/device/worker bundles), and you can pass .kernelBundle
// individually to makeSwingsetController's
// runtimeOptions.kernelBundle

// Tests can also pass the whole result to buildVatController's
// runtimeOptions.kernelBundles, which will pass it through to both.

export async function buildKernelBundles() {
  trace('buildKernelBundles');
  const bp = buildVatAndDeviceBundles();
  const kp = buildKernelBundle();
  const [vdBundles, kernelBundle] = await Promise.all([bp, kp]);
  return harden({ kernel: kernelBundle, ...vdBundles });
}

function byName(a, b) {
  if (a.name < b.name) {
    return -1;
  }
  if (a.name > b.name) {
    return 1;
  }
  return 0;
}

/**
 * Scan a directory for files defining the vats to bootstrap for a swingset, and
 * produce a swingset config object for what was found there.  Looks for files
 * with names of the pattern `vat-NAME.js` as well as a file named
 * 'bootstrap.js'.
 *
 * @param {string} basedir  The directory to scan
 * @param {object} [options]
 * @param {boolean} [options.includeDevDependencies] whether to include devDependencies
 * @param {BundleFormat} [options.bundleFormat] the bundle format to use
 * @returns {SwingSetConfig} a swingset config object: {
 *   bootstrap: "bootstrap",
 *   vats: {
 *     NAME: {
 *       sourceSpec: PATHSTRING
 *     }
 *   }
 * }
 *
 * Where NAME is the name of the vat; `sourceSpec` contains the path to the vat with that name.  Note that
 * the `bootstrap` property names the vat that should be used as the bootstrap vat.  Although a swingset
 * configuration can designate any vat as its bootstrap vat, `loadBasedir` will always look for a file named
 * 'bootstrap.js' and use that (note that if there is no 'bootstrap.js', there will be no bootstrap vat).
 *
 * Swingsets defined by scanning a directory in this manner define no devices.
 */
export function loadBasedir(basedir, options = {}) {
  const { includeDevDependencies = false, bundleFormat = undefined } = options;
  /** @type { SwingSetConfigDescriptor } */
  const vats = {};
  const subs = fs.readdirSync(basedir, { withFileTypes: true });
  subs.sort(byName);
  subs.forEach(dirent => {
    if (
      dirent.name.startsWith('vat-') &&
      dirent.name.endsWith('.js') &&
      dirent.isFile()
    ) {
      const name = dirent.name.slice('vat-'.length, -'.js'.length);
      const vatSourcePath = path.resolve(basedir, dirent.name);
      vats[name] = { sourceSpec: vatSourcePath, parameters: {} };
    }
  });
  /** @type {string | void} */
  let bootstrapPath = path.resolve(basedir, 'bootstrap.js');
  try {
    fs.statSync(bootstrapPath);
  } catch (e) {
    // TODO this will catch the case of the file not existing but doesn't check
    // that it's a plain file and not a directory or something else unreadable.
    // Consider putting in a more sophisticated check if this whole directory
    // scanning thing is something we decide we want to have long term.
    bootstrapPath = undefined;
  }
  const config = { vats, includeDevDependencies, format: bundleFormat };
  if (bootstrapPath) {
    vats.bootstrap = {
      sourceSpec: bootstrapPath,
      parameters: {},
    };
    config.bootstrap = 'bootstrap';
  }
  return config;
}

/**
 * Resolve a pathname found in a config descriptor.  First try to resolve it as
 * a module path, and then if that doesn't work try to resolve it as an
 * ordinary path relative to the directory in which the config file was found.
 *
 * @param {string} referrer  URL of file or directory containing the config file
 * @param {string} specPath  Path found in a `sourceSpec` or `bundleSpec` property
 *
 * @returns {Promise<string>} the absolute path corresponding to `specPath` if it can be
 *    determined.
 */
async function resolveSpecFromConfig(referrer, specPath) {
  try {
    // eslint-disable-next-line @jessie.js/no-nested-await
    return new URL(await resolveModuleSpecifier(specPath, referrer)).pathname;
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND' && e.code !== 'ERR_MODULE_NOT_FOUND') {
      throw e;
    }
  }
  return new URL(specPath, referrer).pathname;
}

/**
 * For each entry in a config descriptor (i.e, `vats`, `bundles`, etc), convert
 * it to normal form: resolve each pathname to a context-insensitive absolute
 * path and make sure it has a `parameters` property if it's supposed to.
 *
 * @param {SwingSetConfigDescriptor | void} desc  The config descriptor to be normalized.
 * @param {string} referrer  The pathname of the file or directory in which the
 * config file was found
 * @param {boolean} expectParameters `true` if the entries should have parameters (for
 *    example, `true` for `vats` but `false` for bundles).
 */
async function normalizeConfigDescriptor(desc, referrer, expectParameters) {
  const normalizeSpec = async (entry, key) => {
    return resolveSpecFromConfig(referrer, entry[key]).then(spec => {
      entry[key] = spec;
    });
  };

  const jobs = [];
  if (desc) {
    for (const name of Object.keys(desc)) {
      const entry = desc[name];
      if ('sourceSpec' in entry) {
        jobs.push(normalizeSpec(entry, 'sourceSpec'));
      }
      if ('bundleSpec' in entry) {
        jobs.push(normalizeSpec(entry, 'bundleSpec'));
      }
      if (expectParameters && !entry.parameters) {
        entry.parameters = {};
      }
    }
  }
  return Promise.all(jobs);
}

/**
 * Read and parse a swingset config file and return it in normalized form.
 *
 * @param {string} configPath  Path to the config file to be processed
 *
 * @returns {Promise<SwingSetConfig | null>} the contained config object, in normalized form, or null if the
 *    requested config file did not exist.
 *
 * @throws {Error} if the file existed but was inaccessible, malformed, or otherwise
 *    invalid.
 */
export async function loadSwingsetConfigFile(configPath) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const referrer = new URL(
      configPath,
      `file:///${process.cwd()}/`,
    ).toString();
    // eslint-disable-next-line @jessie.js/no-nested-await
    await normalizeConfigDescriptor(config.vats, referrer, true);
    // eslint-disable-next-line @jessie.js/no-nested-await
    await normalizeConfigDescriptor(config.bundles, referrer, false);
    // await normalizeConfigDescriptor(config.devices, referrer, true); // TODO: represent devices
    config.bootstrap || Fail`no designated bootstrap vat in ${configPath}`;
    (config.vats && config.vats[config.bootstrap]) ||
      Fail`bootstrap vat ${config.bootstrap} not found in ${configPath}`;
    return config;
  } catch (e) {
    if (e.code === 'ENOENT') {
      return null;
    } else {
      throw e;
    }
  }
}

export function swingsetIsInitialized(kernelStorage) {
  return !!kernelStorage.kvStore.get('initialized');
}

/**
 * @param {Record<string, any>} obj
 * @param {(string|undefined)[]} [firsts]
 * @returns {Record<string, any>}
 */
function sortObjectProperties(obj, firsts = []) {
  const sorted = [...firsts, ...Object.keys(obj).sort()];
  const result = {};
  for (const prop of sorted) {
    if (prop && result[prop] === undefined && obj[prop] !== undefined) {
      result[prop] = obj[prop];
    }
  }
  return result;
}

/** @typedef {{ kernelBundles?: Record<string, Bundle>, verbose?: boolean,
 *              addVatAdmin?: boolean, addComms?: boolean, addVattp?: boolean,
 *              addTimer?: boolean,
 *            }} InitializationOptions
 */

/**
 * @param {SwingSetConfig} config
 * @param {string[]} argv
 * @param {SwingStoreKernelStorage} kernelStorage
 * @param {InitializationOptions} initializationOptions
 * @param {{ env?: Record<string, string | undefined > }} runtimeOptions
 */
export async function initializeSwingset(
  config,
  argv = [],
  kernelStorage,
  initializationOptions = {},
  runtimeOptions = {},
) {
  const kvStore = kernelStorage.kvStore;
  insistStorageAPI(kvStore);
  !swingsetIsInitialized(kernelStorage) ||
    Fail`kernel store already initialized`;

  // copy config so we can safely mess with it even if it's shared or hardened
  config = JSON.parse(JSON.stringify(config));
  if (!config.bundles) {
    config.bundles = {};
  }
  if (!config.vats) {
    config.vats = {};
  }
  if (!config.devices) {
    config.devices = {};
  }

  // Use ambient process.env only if caller did not specify.
  const { env: { SWINGSET_WORKER_TYPE } = process.env } = runtimeOptions;

  // Override the worker type if specified by the caller, to avoid having to
  // edit the config just to run everything under a different manager.
  const defaultManagerType = SWINGSET_WORKER_TYPE || config.defaultManagerType;
  switch (defaultManagerType) {
    case 'local':
    case 'xs-worker':
      config.defaultManagerType = defaultManagerType;
      break;
    case undefined:
      config.defaultManagerType = 'local';
      break;
    default:
      Fail`unknown manager type ${defaultManagerType}`;
  }

  const obtainKernelBundles = async () =>
    initializationOptions.kernelBundles || buildVatAndDeviceBundles();
  const kernelBundles = await obtainKernelBundles();
  const {
    verbose,
    addVatAdmin = true,
    addComms = true,
    addVattp = true,
    addTimer = true,
  } = initializationOptions;

  assert.typeof(kernelBundles.lockdown, 'object');
  assert.typeof(kernelBundles.supervisor, 'object');
  kvStore.set('lockdownBundle', JSON.stringify(kernelBundles.lockdown));
  kvStore.set('supervisorBundle', JSON.stringify(kernelBundles.supervisor));

  if (config.bootstrap && argv) {
    const bootConfig = config.vats[config.bootstrap];
    if (bootConfig) {
      if (!bootConfig.parameters) {
        bootConfig.parameters = {};
      }
      bootConfig.parameters.argv = argv;
    }
  }

  if (addVatAdmin) {
    // vatAdmin and bundle devices are given endowments by the kernel itself
    config.vats.vatAdmin = {
      bundle: kernelBundles.adminVat,
    };
    config.devices.vatAdmin = {
      bundle: kernelBundles.adminDevice,
    };
  }

  if (addComms) {
    // comms vat is added automatically, but TODO: bootstraps must still
    // connect it to vat-tp. TODO: test-message-patterns builds two comms and
    // two vattps, must handle somehow.
    config.vats.comms = {
      bundle: kernelBundles.comms,
      creationOptions: {
        enablePipelining: true,
        // The use of setup rather than buildRootObject requires
        // a local worker. We have no plans to support setup on
        // non-local workers any time soon.
        enableSetup: true,
        managerType: 'local',
        useTranscript: false,
        reapInterval: 'never',
      },
    };
  }

  if (addVattp) {
    // vat-tp is added automatically, but TODO: bootstraps must still connect
    // it to comms
    config.vats.vattp = {
      bundle: kernelBundles.vattp,
    };
  }

  if (addTimer) {
    // timer wrapper vat is added automatically, but TODO: bootstraps must
    // still provide a timer device, and connect it to the wrapper vat
    config.vats.timer = {
      bundle: kernelBundles.timer,
    };
  }

  // The host application gives us
  // config.[vats|devices].NAME.[bundle|bundleSpec|sourceSpec|bundleName] .
  // The 'bundleName' option points into
  // config.bundles.BUNDLENAME.[bundle|bundleSpec|sourceSpec] , which can
  // also include arbitrary named bundles that will be made available to
  // E(vatAdminService).getNamedBundleCap(bundleName) ,and temporarily as
  // E(vatAdminService).createVatByName(bundleName)

  // The 'kconfig' we pass through to initializeKernel has
  // kconfig.[vats|devices].NAME.bundleID and
  // kconfig.namedBundleIDs.BUNDLENAME=bundleID , which both point into
  // kconfig.idToBundle.BUNDLEID=bundle

  const bundleCache = await makeNodeBundleCache(
    'bundles/',
    { dev: config.includeDevDependencies, format: config.bundleFormat },
    s => import(s),
  );

  async function getBundle(desc, mode, nameToBundle) {
    trace(
      'getBundle',
      mode,
      Object.keys(desc),
      desc.moduleFormat,
      desc.endoZipBase64Sha512 || desc.sourceSpec,
    );
    if (mode === 'bundle') {
      return desc.bundle;
    } else if (mode === 'bundleSpec') {
      return JSON.parse(fs.readFileSync(desc.bundleSpec).toString());
    } else if (mode === 'sourceSpec') {
      return bundleCache.load(desc.sourceSpec);
    } else if (mode === 'bundleName') {
      assert(nameToBundle, `cannot use .bundleName in config.bundles`);
      const bundle = nameToBundle[desc.bundleName];
      assert(bundle, `unknown bundleName ${desc.bundleName}`);
      return bundle;
    }
    throw Error(`unknown mode ${mode}`);
  }

  // fires with BundleWithID: { ...bundle, id }
  /**
   * @param {EndoZipBase64Bundle & {id?: string}} bundle
   */
  async function addBundleID(bundle) {
    if ('id' in bundle) {
      // during config, we believe bundle.id, but not at runtime!
      return bundle;
    }
    const { endoZipBase64Sha512 } = bundle;
    assert.typeof(endoZipBase64Sha512, 'string');
    return {
      ...bundle,
      id: `b1-${endoZipBase64Sha512}`,
    };
  }

  // fires with BundleWithID: { ...bundle, id }
  async function processDesc(desc, nameToBundle) {
    const allModes = ['bundle', 'bundleSpec', 'sourceSpec', 'bundleName'];
    const modes = allModes.filter(mode => mode in desc);
    assert(
      modes.length === 1,
      `need =1 of bundle/bundleSpec/sourceSpec/bundleName, got ${modes}`,
    );
    const mode = modes[0];
    return getBundle(desc, mode, nameToBundle)
      .then(addBundleID)
      .then(bundleWithID => {
        const emptyBundleSize = 11320;
        const thisBundleSize = bundleWithID.endoZipBase64.length;
        if (thisBundleSize < emptyBundleSize * 2) {
          console.warn(
            `suspiciously small bundle size ${q(thisBundleSize)} in ${q(
              desc,
            )} (${q(mode)})`,
          );
        }
        // replace original .sourceSpec/etc with a uniform .bundleID
        delete desc[mode];
        desc.bundleID = bundleWithID.id;
        return bundleWithID;
      });
  }

  async function processGroup(groupName, nameToBundle) {
    const group = config[groupName] || {};
    const names = Object.keys(group).sort();
    const processP = names.map(name =>
      processDesc(group[name], nameToBundle).catch(err => {
        throw Error(`config.${groupName}.${name}: ${err.message}`);
      }),
    );
    const bundlesWithID = await Promise.all(processP);
    const newNameToBundle = {};
    const idToBundle = {};
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      const bundle = bundlesWithID[i];
      const id = bundle.id;
      newNameToBundle[name] = bundle;
      idToBundle[id] = bundle;
    }
    return [newNameToBundle, idToBundle];
  }

  // for each config.bundles.NAME, do whatever bundling/reading is necessary
  // to get a bundle and bundleID, and return both the name->bundleID record
  // (to populate config.namedBundles) and the bundleID->bundle record (to
  // install the actual bundles)

  config.bundles = sortObjectProperties(config.bundles);
  config.vats = sortObjectProperties(config.vats, [
    config.bootstrap,
    'vatAdmin',
    'comms',
    'vattp',
    'timer',
  ]);
  config.devices = sortObjectProperties(config.devices);
  const [nameToBundle, idToNamedBundle] = await processGroup('bundles');
  const [_1, idToVatBundle] = await processGroup('vats', nameToBundle);
  const [_2, idToDeviceBundle] = await processGroup('devices', nameToBundle);
  /** @type { SwingSetKernelConfig } */
  const kconfig = {
    ...config,
    namedBundleIDs: {},
    idToBundle: sortObjectProperties({
      ...idToNamedBundle,
      ...idToVatBundle,
      ...idToDeviceBundle,
    }),
  };
  for (const name of Object.keys(nameToBundle)) {
    kconfig.namedBundleIDs[name] = nameToBundle[name].id;
  }
  delete kconfig.bundles;

  if (verbose) {
    kdebugEnable(true);
  }
  return initializeKernel(kconfig, kernelStorage);
}
