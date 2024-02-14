// @ts-check
/* eslint @typescript-eslint/no-floating-promises: "warn" */
import { E, Far } from '@endo/far';
import { makeNameHubKit } from '@agoric/vats/src/nameHub.js';
import { observeIteration, subscribeEach } from '@agoric/notifier';

export const CONTRACT_NAME = 'Pegasus';

const t = 'pegasus';

export const getManifestForPegasus = ({ restoreRef }, { pegasusRef }) => ({
  manifest: {
    startPegasus: {
      consume: { board: t, namesByAddress: t, zoe: t },
      installation: {
        consume: { [CONTRACT_NAME]: t },
      },
      instance: {
        produce: { [CONTRACT_NAME]: t },
      },
    },
    listenPegasus: {
      consume: { networkVat: t, pegasusConnectionsAdmin: t, zoe: t },
      produce: { pegasusConnections: t, pegasusConnectionsAdmin: t },
      instance: {
        consume: { [CONTRACT_NAME]: t },
      },
    },
    [publishConnections.name]: {
      consume: { pegasusConnections: t, client: t },
    },
  },
  installations: {
    [CONTRACT_NAME]: restoreRef(pegasusRef),
  },
});

export const startPegasus = async ({
  consume: { board: boardP, namesByAddress: namesByAddressP, zoe },
  installation: {
    consume: { [CONTRACT_NAME]: pegasusInstall },
  },
  instance: {
    produce: { [CONTRACT_NAME]: produceInstance },
  },
}) => {
  const [board, namesByAddress] = await Promise.all([boardP, namesByAddressP]);
  const terms = { board, namesByAddress };

  const { instance } = await E(zoe).startInstance(
    pegasusInstall,
    undefined,
    terms,
  );

  produceInstance.resolve(instance);
};
harden(startPegasus);

/**
 * @param {Port} port
 * @param {*} pegasus
 * @param {import('@agoric/vats').NameAdmin} pegasusConnectionsAdmin
 */
export const addPegasusTransferPort = async (
  port,
  pegasus,
  pegasusConnectionsAdmin,
) => {
  const { pfmHandler, subscription } = await E(pegasus).makePegasusConnectionKit();
  observeIteration(subscribeEach(subscription), {
    updateState(connectionState) {
      const { localAddr, actions } = connectionState;
      if (actions) {
        // We're open and ready for business.
        E(pegasusConnectionsAdmin).update(localAddr, connectionState); // !!! Wrap around E()
      } else {
        // We're closed.
        E(pegasusConnectionsAdmin).delete(localAddr); // !!! Wrap around E()
      }
    },
  });
  return E(port).addListener(
    Far('listener', {
      async onAccept(_port, _localAddr, _remoteAddr, _listenHandler) {
        return pfmHandler;
      },
      async onListen(p, _listenHandler) {
        console.debug(`Listening on Pegasus transfer port: ${p}`);
      },
    }),
  );
};
harden(addPegasusTransferPort);

export const listenPegasus = async ({
  consume: { networkVat, pegasusConnectionsAdmin: pegasusNameAdmin, zoe },
  produce: { pegasusConnections, pegasusConnectionsAdmin },
  instance: {
    consume: { [CONTRACT_NAME]: pegasusInstance },
  },
}) => {
  const { nameHub, nameAdmin } = makeNameHubKit();
  pegasusConnections.resolve(nameHub);
  pegasusConnectionsAdmin.resolve(nameAdmin);

  const pegasus = await E(zoe).getPublicFacet(pegasusInstance);
  const port = await E(networkVat).bind('/ibc-port/pegasus');
  return addPegasusTransferPort(port, pegasus, pegasusNameAdmin);
};
harden(listenPegasus);

export const publishConnections = async ({
  consume: { pegasusConnections: pegasusConnectionsP, client },
}) => {
  const pegasusConnections = await pegasusConnectionsP;
  // FIXME: Be sure only to give the client the connections if _addr is on the
  // allowlist.
  return E(client).assignBundle([_addr => ({ pegasusConnections })]);
};
harden(publishConnections);
