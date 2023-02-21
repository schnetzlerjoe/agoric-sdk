import '@agoric/zoe/exported.js';
import { AmountMath, AmountShape } from '@agoric/ertp';
import { M } from '@agoric/store';

const SwapProposalShape = M.splitRecord({
  give: {
    In: AmountShape,
  },
  want: {
    Out: AmountShape,
  },
});

/**
 * @param {ZCF} zcf
 * @param {(brandIn: Brand, brandOut: Brand) => VirtualPool} provideVPool
 */
export const makeMakeSwapInvitation = (zcf, provideVPool) => {
  /**
   * trade with a stated amountIn.
   *
   * @param {ZCFSeat} seat
   * @param {{ stopAfter: Amount }} args
   */
  const swapIn = (seat, args) => {
    const {
      give: { In: amountIn },
      want: { Out: amountOut },
    } = seat.getProposal();
    if (args) {
      AmountMath.coerce(amountOut.brand, args.stopAfter);
      // TODO check that there are no other keys
    }

    const pool = provideVPool(amountIn.brand, amountOut.brand);
    let prices;
    const stopAfter = args && args.stopAfter;
    if (stopAfter) {
      AmountMath.coerce(amountOut.brand, stopAfter);
      prices = pool.getPriceForOutput(amountIn, stopAfter);
    }
    if (!prices || !AmountMath.isGTE(prices.swapperGets, stopAfter)) {
      // `amountIn` is not enough to sell for stopAfter so just sell it all
      prices = pool.getPriceForInput(amountIn, amountOut);
    }
    assert(amountIn.brand === prices.swapperGives.brand);
    return pool.allocateGainsAndLosses(seat, prices);
  };

  // trade with a stated amount out.
  const swapOut = seat => {
    const {
      give: { In: amountIn },
      want: { Out: amountOut },
    } = seat.getProposal();
    const pool = provideVPool(amountIn.brand, amountOut.brand);
    const prices = pool.getPriceForOutput(amountIn, amountOut);
    return pool.allocateGainsAndLosses(seat, prices);
  };

  const makeSwapInInvitation = () =>
    zcf.makeInvitation(swapIn, 'autoswap swapIn', undefined, SwapProposalShape);

  const makeSwapOutInvitation = () =>
    zcf.makeInvitation(
      swapOut,
      'autoswap swapOut',
      undefined,
      SwapProposalShape,
    );

  return { makeSwapInInvitation, makeSwapOutInvitation };
};
