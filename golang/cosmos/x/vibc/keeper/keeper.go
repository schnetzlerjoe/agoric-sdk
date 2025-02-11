package keeper

import (
	"fmt"

	"github.com/cosmos/cosmos-sdk/codec"
	storetypes "github.com/cosmos/cosmos-sdk/store/types"
	sdk "github.com/cosmos/cosmos-sdk/types"

	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
	capabilitykeeper "github.com/cosmos/cosmos-sdk/x/capability/keeper"
	capability "github.com/cosmos/cosmos-sdk/x/capability/types"
	clienttypes "github.com/cosmos/ibc-go/v6/modules/core/02-client/types"
	channeltypes "github.com/cosmos/ibc-go/v6/modules/core/04-channel/types"
	porttypes "github.com/cosmos/ibc-go/v6/modules/core/05-port/types"
	host "github.com/cosmos/ibc-go/v6/modules/core/24-host"
	ibcexported "github.com/cosmos/ibc-go/v6/modules/core/exported"

	bankkeeper "github.com/cosmos/cosmos-sdk/x/bank/keeper"

	vm "github.com/Agoric/agoric-sdk/golang/cosmos/vm"
	"github.com/Agoric/agoric-sdk/golang/cosmos/x/vibc/types"
)

// Keeper maintains the link to data storage and exposes getter/setter methods for the various parts of the state machine
type Keeper struct {
	storeKey storetypes.StoreKey
	cdc      codec.Codec

	channelKeeper types.ChannelKeeper
	portKeeper    types.PortKeeper
	scopedKeeper  capabilitykeeper.ScopedKeeper
	bankKeeper    bankkeeper.Keeper

	PushAction vm.ActionPusher
}

// NewKeeper creates a new dIBC Keeper instance
func NewKeeper(
	cdc codec.Codec, key storetypes.StoreKey,
	channelKeeper types.ChannelKeeper, portKeeper types.PortKeeper,
	bankKeeper bankkeeper.Keeper,
	scopedKeeper capabilitykeeper.ScopedKeeper,
	pushAction vm.ActionPusher,
) Keeper {

	return Keeper{
		storeKey:      key,
		cdc:           cdc,
		bankKeeper:    bankKeeper,
		channelKeeper: channelKeeper,
		portKeeper:    portKeeper,
		scopedKeeper:  scopedKeeper,
		PushAction:    pushAction,
	}
}

func (k Keeper) GetBalance(ctx sdk.Context, addr sdk.AccAddress, denom string) sdk.Coin {
	return k.bankKeeper.GetBalance(ctx, addr, denom)
}

// GetChannel defines a wrapper function for the channel Keeper's function
// in order to expose it to the vibc IBC handler.
func (k Keeper) GetChannel(ctx sdk.Context, portID, channelID string) (channeltypes.Channel, bool) {
	return k.channelKeeper.GetChannel(ctx, portID, channelID)
}

// ChanOpenInit defines a wrapper function for the channel Keeper's function
// in order to expose it to the vibc IBC handler.
func (k Keeper) ChanOpenInit(ctx sdk.Context, order channeltypes.Order, connectionHops []string,
	portID, rPortID, version string,
) error {
	capName := host.PortPath(portID)
	portCap, ok := k.GetCapability(ctx, capName)
	if !ok {
		return sdkerrors.Wrapf(porttypes.ErrInvalidPort, "could not retrieve port capability at: %s", capName)
	}
	counterparty := channeltypes.Counterparty{
		PortId: rPortID,
	}
	channelID, chanCap, err := k.channelKeeper.ChanOpenInit(ctx, order, connectionHops, portID, portCap, counterparty, version)
	if err != nil {
		return err
	}
	chanCapName := host.ChannelCapabilityPath(portID, channelID)
	err = k.ClaimCapability(ctx, chanCap, chanCapName)
	if err != nil {
		return err
	}

	k.channelKeeper.WriteOpenInitChannel(ctx, portID, channelID, order, connectionHops, counterparty, version)
	return nil
}

// SendPacket defines a wrapper function for the channel Keeper's function
// in order to expose it to the vibc IBC handler.
func (k Keeper) SendPacket(
	ctx sdk.Context,
	sourcePort string,
	sourceChannel string,
	timeoutHeight clienttypes.Height,
	timeoutTimestamp uint64,
	data []byte,
) (uint64, error) {
	capName := host.ChannelCapabilityPath(sourcePort, sourceChannel)
	chanCap, ok := k.GetCapability(ctx, capName)
	if !ok {
		return 0, sdkerrors.Wrapf(channeltypes.ErrChannelCapabilityNotFound, "could not retrieve channel capability at: %s", capName)
	}
	return k.channelKeeper.SendPacket(ctx, chanCap, sourcePort, sourceChannel, timeoutHeight, timeoutTimestamp, data)
}

var _ ibcexported.Acknowledgement = (*rawAcknowledgement)(nil)

type rawAcknowledgement struct {
	data []byte
}

func (r rawAcknowledgement) Acknowledgement() []byte {
	return r.data
}

func (r rawAcknowledgement) Success() bool {
	return true
}

// WriteAcknowledgement defines a wrapper function for the channel Keeper's function
// in order to expose it to the vibc IBC handler.
func (k Keeper) WriteAcknowledgement(ctx sdk.Context, packet ibcexported.PacketI, acknowledgement []byte) error {
	portID := packet.GetDestPort()
	channelID := packet.GetDestChannel()
	capName := host.ChannelCapabilityPath(portID, channelID)
	chanCap, ok := k.GetCapability(ctx, capName)
	if !ok {
		return sdkerrors.Wrapf(channeltypes.ErrChannelCapabilityNotFound, "could not retrieve channel capability at: %s", capName)
	}
	ack := rawAcknowledgement{
		data: acknowledgement,
	}
	return k.channelKeeper.WriteAcknowledgement(ctx, chanCap, packet, ack)
}

// ChanCloseInit defines a wrapper function for the channel Keeper's function
// in order to expose it to the vibc IBC handler.
func (k Keeper) ChanCloseInit(ctx sdk.Context, portID, channelID string) error {
	capName := host.ChannelCapabilityPath(portID, channelID)
	chanCap, ok := k.GetCapability(ctx, capName)
	if !ok {
		return sdkerrors.Wrapf(channeltypes.ErrChannelCapabilityNotFound, "could not retrieve channel capability at: %s", capName)
	}
	err := k.channelKeeper.ChanCloseInit(ctx, portID, channelID, chanCap)
	if err != nil {
		return err
	}
	return nil
}

// BindPort defines a wrapper function for the port Keeper's function in
// order to expose it to the vibc IBC handler.
func (k Keeper) BindPort(ctx sdk.Context, portID string) error {
	_, ok := k.scopedKeeper.GetCapability(ctx, host.PortPath(portID))
	if ok {
		return fmt.Errorf("port %s is already bound", portID)
	}
	cap := k.portKeeper.BindPort(ctx, portID)
	return k.ClaimCapability(ctx, cap, host.PortPath(portID))
}

// TimeoutExecuted defines a wrapper function for the channel Keeper's function
// in order to expose it to the vibc IBC handler.
func (k Keeper) TimeoutExecuted(ctx sdk.Context, packet ibcexported.PacketI) error {
	portID := packet.GetSourcePort()
	channelID := packet.GetSourceChannel()
	capName := host.ChannelCapabilityPath(portID, channelID)
	chanCap, ok := k.GetCapability(ctx, capName)
	if !ok {
		return sdkerrors.Wrapf(channeltypes.ErrChannelCapabilityNotFound, "could not retrieve channel capability at: %s", capName)
	}
	return k.channelKeeper.TimeoutExecuted(ctx, chanCap, packet)
}

// ClaimCapability allows the vibc module to claim a capability that IBC module
// passes to it
func (k Keeper) ClaimCapability(ctx sdk.Context, cap *capability.Capability, name string) error {
	return k.scopedKeeper.ClaimCapability(ctx, cap, name)
}

func (k Keeper) GetCapability(ctx sdk.Context, name string) (*capability.Capability, bool) {
	return k.scopedKeeper.GetCapability(ctx, name)
}
