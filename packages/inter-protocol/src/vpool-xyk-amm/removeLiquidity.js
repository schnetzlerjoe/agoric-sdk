import '@agoric/zoe/exported.js';
import { M } from '@agoric/store';
import { AmountShape } from '@agoric/ertp';

/**
 * @param {ZCF} zcf
 * @param {(brand: Brand) => XYKPool} getPool
 */
export const makeMakeRemoveLiquidityInvitation = (zcf, getPool) => {
  const removeLiquidity = seat => {
    // Get the brand of the secondary token so we can identify the liquidity pool.
    const secondaryBrand = seat.getProposal().want.Secondary.brand;
    const pool = getPool(secondaryBrand);
    return pool.removeLiquidity(seat);
  };

  const RemoveLiquidityProposalShape = M.splitRecord({
    want: {
      Central: AmountShape, // TODO brand specific AmountShape
      Secondary: AmountShape, // TODO brand specific AmountShape
    },
    give: {
      Liquidity: AmountShape, // TODO brand specific AmountShape
    },
  });

  const makeRemoveLiquidityInvitation = () =>
    zcf.makeInvitation(
      removeLiquidity,
      'autoswap remove liquidity',
      undefined,
      RemoveLiquidityProposalShape,
    );
  return makeRemoveLiquidityInvitation;
};
