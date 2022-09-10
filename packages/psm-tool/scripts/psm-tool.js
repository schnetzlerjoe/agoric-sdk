#!/usr/bin/env node
/* global process, fetch */
// @ts-check
import {
  assert,
  asPercent,
  getContractState,
  getWalletState,
  makeAgoricNames,
  makeFromBoard,
  makePSMSpendAction,
  miniMarshal,
  networks,
  simpleOffers,
  simplePurseBalances,
  vstorage,
} from '../src/psm-lib.js';

const USAGE = `
Usage:
to get contract instance boardId and, optionally, fees
  psm-tool --contract [--verbose]
to write an offer to stdout
  psm-tool --wantMinted ANCHOR_TOKENS --boardId BOARD_ID [--feePct PCT]
  psm-tool --giveMinted IST_TOKENS --boardId BOARD_ID [--feePct PCT]
to get succinct offer status and purse balances
  psm-tool --wallet AGORIC_ADDRESS

NOTE: --contract and --wallet may need --experimental-fetch node option.

For example:

psmInstance=$(psm-tool --contract)
psm-tool --contract --verbose # to get fees
psm-tool --wantMinted 100 --boardId $psmInstance --feePct 0.01 >,psm-offer-action.json

# sign and send
agd --node=${networks.xnet.rpc} --chain-id=agoricxnet-13 \
  --from=LEDGER_KEY_NAME --sign-mode=amino-json \
  tx swingset wallet-action --allow-spend "$(cat ,psm-offer-action.json)"    

# check results
psm-tool --wallet agoric1....
`;

/**
 * @param {string[]} argv
 * @param {string[]} [flagNames] options that don't take values
 */
const parseArgs = (argv, flagNames = []) => {
  /** @type {string[]} */
  const args = [];
  /** @type {Record<string, string>} */
  const opts = {};
  /** @type {Record<string, boolean>} */
  const flags = {};

  let ix = 0;
  while (ix < argv.length) {
    const arg = argv[ix];
    if (arg.startsWith('--')) {
      const opt = arg.slice('--'.length);
      if (flagNames.includes(arg)) {
        flags[opt] = true;
      } else {
        ix += 1;
        const val = argv[ix];
        opts[opt] = val;
      }
    } else {
      args.push(arg);
    }
    ix += 1;
  }
  return { args, opts, flags };
};

// const log = label => x => {
//   console.error(label, x);
//   return x;
// };
const log = _label => x => x;

const fmtRecordOfLines = record => {
  const { stringify } = JSON;
  const groups = Object.entries(record).map(([key, items]) => [
    key,
    items.map(item => `    ${stringify(item)}`),
  ]);
  const lineEntries = groups.map(
    ([key, lines]) => `  ${stringify(key)}: [\n${lines.join(',\n')}\n  ]`,
  );
  return `{XXX\n${lineEntries.join(',\n')}\n}`;
};

/**
 * @param {{wallet?: string, net?: string}} opts
 * @param {{contract?: boolean, verbose?: boolean}} flags
 * @param {object} io
 * @param {typeof fetch} io.fetch
 */
const online = async (opts, flags, { fetch }) => {
  const net = networks[opts.net || 'local'];
  assert(net, opts.net);
  const getJSON = async url => (await fetch(log('url')(net.rpc + url))).json();

  if (flags.verbose) {
    // const status = await getJSON(`${RPC_BASE}/status?`);
    // console.log({ status });
    const raw = await getJSON(vstorage.url());
    const top = vstorage.decode(raw);
    console.error(
      JSON.stringify(['vstorage published.*', JSON.parse(top).children]),
    );
  }

  const fromBoard = makeFromBoard();
  const agoricNames = await makeAgoricNames(fromBoard, getJSON);

  if (flags.contract) {
    const { instance, governance } = await getContractState(
      fromBoard,
      agoricNames,
      {
        getJSON,
      },
    );
    flags.verbose && console.error('psm', instance, Object.keys(governance));
    flags.verbose &&
      console.error(
        'WantMintedFee',
        asPercent(governance.WantMintedFee.value),
        '%',
        'GiveMintedFee',
        asPercent(governance.GiveMintedFee.value),
        '%',
      );
    console.info(instance.boardId);
    return 0;
  } else if (opts.wallet) {
    const state = await getWalletState(opts.wallet, fromBoard, {
      getJSON,
    });
    const { purses } = state;
    // console.log(JSON.stringify(offers, null, 2));
    // console.log(JSON.stringify({ offers, purses }, bigIntReplacer, 2));
    const summary = {
      balances: simplePurseBalances(purses),
      offers: simpleOffers(state, agoricNames),
    };
    console.log(fmtRecordOfLines(summary));
    return 0;
  }

  return 1;
};

/**
 * @param {string[]} argv
 * @param {object} io
 * @param {typeof fetch} [io.fetch]
 * @param {() => Date} io.clock
 */
const main = async (argv, { fetch, clock }) => {
  const { opts, flags } = parseArgs(argv, ['--contract', '--verbose']);

  if (flags.contract || opts.wallet) {
    assert(fetch, 'missing fetch API; try --experimental-fetch?');
    // @ts-expect-error what's up with typeof fetch???
    return online(opts, flags, { fetch });
  }

  if (!(opts.wantMinted || opts.giveMinted)) {
    console.error(USAGE);
    return 1;
  }

  const fromBoard = makeFromBoard();
  const net = networks[opts.net || 'local'];
  assert(net, opts.net);
  const getJSON = async url => (await fetch(log('url')(net.rpc + url))).json();
  const agoricNames = await makeAgoricNames(fromBoard, getJSON);
  const instance = agoricNames.instance['psm-IST-AUSD'];
  const spendAction = makePSMSpendAction(
    instance,
    agoricNames.brand,
    // @ts-expect-error
    opts,
    clock().valueOf(),
  );
  console.log(JSON.stringify(miniMarshal().serialize(spendAction)));
  return 0;
};

main([...process.argv], {
  // support pre-fetch node for some modes
  fetch: typeof fetch === 'function' ? fetch : undefined,
  clock: () => new Date(),
}).then(
  code => process.exit(code),
  err => console.error(err),
);