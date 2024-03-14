// @ts-check
import { E } from '@endo/far';
import { M } from '@endo/patterns';
import { AmountShape } from '@agoric/ertp';

const { Fail, bare } = assert;

/**
 * @typedef {{
 *   '@type': string;
 *   [x: string]: unknown;
 * }} Proto3Jsonable
 */

/**
 * @typedef {{
 *   system: import('./types.js').ScopedBridgeManager;
 *   bankManager: import('./vat-bank.js').BankManager;
 *   transfer: import('./transfer.js').TransferMiddleware;
 * }} LocalChainPowers
 *
 * @typedef {MapStore<
 *   keyof LocalChainPowers,
 *   LocalChainPowers[keyof LocalChainPowers]
 * >} PowerStore
 */

/**
 * @template {keyof LocalChainPowers} K
 * @param {PowerStore} powers
 * @param {K} name
 */
const getPower = (powers, name) => {
  powers.has(name) || Fail`need powers.${bare(name)} for this method`;
  return /** @type {LocalChainPowers[K]} */ (powers.get(name));
};

export const LocalChainAccountI = M.interface('LocalChainAccount', {
  getAddress: M.callWhen().returns(M.string()),
  deposit: M.callWhen(M.remotable('Payment'))
    .optional(M.pattern())
    .returns(AmountShape),
  executeTx: M.callWhen(M.arrayOf(M.record())).returns(M.arrayOf(M.record())),
  interceptTransfers: M.callWhen(M.remotable('TransferTap')).returns(
    M.remotable('Unregistrar'),
  ),
});

/** @param {import('@agoric/base-zone').Zone} zone */
const prepareLocalChainAccount = zone =>
  zone.exoClass(
    'LocalChainAccount',
    LocalChainAccountI,
    /**
     * @param {string} address
     * @param {PowerStore} powers
     */
    (address, powers) => ({ address, powers }),
    {
      // Information that the account creator needs.
      async getAddress() {
        return this.state.address;
      },
      /**
       * Deposit a payment into the bank purse that matches the alleged brand.
       * This is safe, since even if the payment lies about its brand, ERTP will
       * reject spoofed payment objects when depositing into a purse.
       *
       * @param {Payment} payment
       */
      async deposit(payment) {
        const { address, powers } = this.state;

        const bankManager = getPower(powers, 'bankManager');

        const allegedBrand = await E(payment).getAllegedBrand();
        const bankAcct = E(bankManager).getBankForAddress(address);
        const allegedPurse = E(bankAcct).getPurse(allegedBrand);
        return E(allegedPurse).deposit(payment);
      },
      async executeTx(messages) {
        const { address, powers } = this.state;
        const obj = {
          type: 'VLOCALCHAIN_EXECUTE_TX',
          // This address is the only one that `VLOCALCHAIN_EXECUTE_TX` will
          // accept as a signer for the transaction.  If the messages have other
          // addresses in signer positions, the transaction will be aborted.
          address,
          messages,
        };
        const system = getPower(powers, 'system');
        return E(system).toBridge(obj);
      },
      async interceptTransfers(tap) {
        const { address, powers } = this.state;
        const transfer = getPower(powers, 'transfer');
        return E(transfer).intercept(address, tap);
      },
    },
  );

export const LocalChainI = M.interface('LocalChain', {
  createAccount: M.callWhen().returns(M.remotable('LocalChainAccount')),
  query: M.callWhen(M.record()).returns(M.record()),
  queryMany: M.callWhen(M.arrayOf(M.record())).returns(M.arrayOf(M.record())),
});

export const LocalChainAdminI = M.interface('LocalChainAdmin', {
  setPower: M.callWhen(M.string(), M.await(M.any())).returns(),
});

/**
 * @param {import('@agoric/base-zone').Zone} zone
 * @param {ReturnType<typeof prepareLocalChainAccount>} createAccount
 */
const prepareLocalChain = (zone, createAccount) =>
  zone.exoClassKit(
    'LocalChain',
    { public: LocalChainI, admin: LocalChainAdminI },
    /** @param {Partial<LocalChainPowers>} [initialPowers] */
    initialPowers => {
      /** @type {PowerStore} */
      const powers = zone.detached().mapStore('PowerStore');
      if (initialPowers) {
        for (const [name, power] of Object.entries(initialPowers)) {
          powers.init(/** @type {keyof LocalChainPowers} */ (name), power);
        }
      }
      return { powers };
    },
    {
      admin: {
        /**
         * @template {keyof LocalChainPowers} K
         * @param {K} name
         * @param {LocalChainPowers[K]} [power]
         */
        setPower(name, power) {
          const { powers } = this.state;
          if (power === undefined) {
            // Remove from powers.
            powers.delete(name);
          } else if (powers.has(name)) {
            // Replace an existing power.
            powers.set(name, power);
          } else {
            // Add a new power.
            powers.init(name, power);
          }
        },
      },
      public: {
        /**
         * Allocate a fresh address that doesn't correspond with a public key,
         * and follows the ICA guidelines to help reduce collisions. See
         * x/vlocalchain/keeper/keeper.go AllocateAddress for the use of the app
         * hash and block data hash.
         */
        async createAccount() {
          const { powers } = this.state;
          const system = getPower(powers, 'system');
          const address = await E(system).toBridge({
            type: 'VLOCALCHAIN_ALLOCATE_ADDRESS',
          });
          return createAccount(address, powers);
        },
        /**
         * Make a single query to the local chain. Will reject with an error if
         * the query fails. Otherwise, return the response as a JSON-compatible
         * object.
         *
         * @param {Proto3Jsonable} request
         * @returns {Promise<Proto3Jsonable>}
         */
        async query(request) {
          const requests = harden([request]);
          const results = await E(this.facets.public).queryMany(requests);
          results.length === 1 ||
            Fail`expected exactly one result; got ${results}`;
          const { error, reply } = results[0];
          if (error) {
            throw Fail`query failed: ${error}`;
          }
          return reply;
        },
        /**
         * Send a batch of query requests to the local chain. Unless there is a
         * system error, will return all results to indicate their success or
         * failure.
         *
         * @param {Proto3Jsonable[]} requests
         * @returns {Promise<{ error?: string; reply: Proto3Jsonable }[]>}
         */
        async queryMany(requests) {
          const { powers } = this.state;
          const system = getPower(powers, 'system');
          return E(system).toBridge({
            type: 'VLOCALCHAIN_QUERY_MANY',
            messages: requests,
          });
        },
      },
    },
  );

/** @param {import('@agoric/base-zone').Zone} zone */
export const prepareLocalChainTools = zone => {
  const createAccount = prepareLocalChainAccount(zone);
  const makeLocalChain = prepareLocalChain(zone, createAccount);

  return harden({ makeLocalChain });
};
harden(prepareLocalChainTools);

/** @typedef {ReturnType<typeof prepareLocalChainTools>} LocalChainTools */
/** @typedef {ReturnType<LocalChainTools['makeLocalChain']>} LocalChainKit */
/** @typedef {LocalChainKit['public']} LocalChain */
