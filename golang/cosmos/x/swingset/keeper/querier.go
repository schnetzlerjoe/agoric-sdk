package keeper

import (
	"fmt"
	"strings"

	abci "github.com/tendermint/tendermint/abci/types"

	"github.com/cosmos/cosmos-sdk/codec"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"

	vstoragetypes "github.com/Agoric/agoric-sdk/golang/cosmos/x/vstorage/types"
)

// query endpoints supported by the swingset Querier
const (
	QueryEgress        = "egress"
	QueryMailbox       = "mailbox"
	LegacyQueryStorage = "storage"
	LegacyQueryKeys    = "keys"
)

// NewQuerier is the module level router for state queries
func NewQuerier(keeper Keeper, legacyQuerierCdc *codec.LegacyAmino) sdk.Querier {
	return func(ctx sdk.Context, path []string, req abci.RequestQuery) (res []byte, err error) {
		switch path[0] {
		case QueryEgress:
			return queryEgress(ctx, path[1], req, keeper, legacyQuerierCdc)
		case QueryMailbox:
			return queryMailbox(ctx, path[1:], req, keeper, legacyQuerierCdc)
		case LegacyQueryStorage:
			return legacyQueryStorage(ctx, strings.Join(path[1:], "/"), req, keeper, legacyQuerierCdc)
		case LegacyQueryKeys:
			return legacyQueryKeys(ctx, strings.Join(path[1:], "/"), req, keeper, legacyQuerierCdc)
		default:
			return nil, sdkerrors.Wrap(sdkerrors.ErrUnknownRequest, "unknown swingset query endpoint")
		}
	}
}

// nolint: unparam
func queryEgress(ctx sdk.Context, bech32 string, req abci.RequestQuery, keeper Keeper, legacyQuerierCdc *codec.LegacyAmino) ([]byte, error) {
	acc, err := sdk.AccAddressFromBech32(bech32)
	if err != nil {
		return nil, sdkerrors.Wrap(sdkerrors.ErrInvalidRequest, err.Error())
	}

	egress := keeper.GetEgress(ctx, acc)
	if egress.Peer.Empty() {
		return []byte{}, sdkerrors.Wrap(sdkerrors.ErrUnknownRequest, fmt.Sprintf("egress %s not found", bech32))
	}

	bz, err := codec.MarshalJSONIndent(legacyQuerierCdc, egress)
	if err != nil {
		return nil, sdkerrors.Wrap(sdkerrors.ErrJSONMarshal, err.Error())
	}

	return bz, nil
}

// nolint: unparam
func queryMailbox(ctx sdk.Context, path []string, req abci.RequestQuery, keeper Keeper, legacyQuerierCdc *codec.LegacyAmino) (res []byte, err error) {
	peer := path[0]

	value := keeper.GetMailbox(ctx, peer)

	if value == "" {
		return []byte{}, sdkerrors.Wrap(sdkerrors.ErrUnknownRequest, "could not get peer mailbox")
	}

	bz, err2 := codec.MarshalJSONIndent(legacyQuerierCdc, vstoragetypes.Data{Value: value})
	if err2 != nil {
		return nil, sdkerrors.Wrap(sdkerrors.ErrJSONMarshal, err2.Error())
	}

	return bz, nil
}

// nolint: unparam
func legacyQueryStorage(ctx sdk.Context, path string, req abci.RequestQuery, keeper Keeper, legacyQuerierCdc *codec.LegacyAmino) (res []byte, err error) {
	entry := keeper.vstorageKeeper.GetData(ctx, path)
	if !entry.IsPresent() {
		return []byte{}, sdkerrors.Wrapf(sdkerrors.ErrUnknownRequest, "could not get swingset %+v", path)
	}

	bz, err2 := codec.MarshalJSONIndent(legacyQuerierCdc, vstoragetypes.Data{Value: entry.Value()})
	if err2 != nil {
		return nil, sdkerrors.Wrap(sdkerrors.ErrJSONMarshal, err2.Error())
	}

	return bz, nil
}

// nolint: unparam
func legacyQueryKeys(ctx sdk.Context, path string, req abci.RequestQuery, keeper Keeper, legacyQuerierCdc *codec.LegacyAmino) (res []byte, err error) {
	children := keeper.vstorageKeeper.GetChildren(ctx, path)
	chlist := children.Children

	if chlist == nil {
		chlist = []string{}
	}

	bz, err2 := codec.MarshalJSONIndent(legacyQuerierCdc, vstoragetypes.Children{Children: chlist})
	if err2 != nil {
		return nil, sdkerrors.Wrap(sdkerrors.ErrJSONMarshal, err2.Error())
	}

	return bz, nil
}
