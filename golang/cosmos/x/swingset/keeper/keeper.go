package keeper

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"

	"github.com/tendermint/tendermint/libs/log"

	"github.com/cosmos/cosmos-sdk/codec"
	sdk "github.com/cosmos/cosmos-sdk/types"
	bankkeeper "github.com/cosmos/cosmos-sdk/x/bank/keeper"
	paramtypes "github.com/cosmos/cosmos-sdk/x/params/types"

	"github.com/Agoric/agoric-sdk/golang/cosmos/vm"
	"github.com/Agoric/agoric-sdk/golang/cosmos/x/swingset/types"
	vstoragekeeper "github.com/Agoric/agoric-sdk/golang/cosmos/x/vstorage/keeper"
	vstoragetypes "github.com/Agoric/agoric-sdk/golang/cosmos/x/vstorage/types"
)

// Top-level paths for chain storage should remain synchronized with
// packages/internal/src/chain-storage-paths.js
const (
	StoragePathActionQueue  = "actionQueue"
	StoragePathActivityhash = "activityhash"
	StoragePathBeansOwing   = "beansOwing"
	StoragePathEgress       = "egress"
	StoragePathMailbox      = "mailbox"
	StoragePathCustom       = "published"
	StoragePathBundles      = "bundles"
)

const MaxUint53 = 9007199254740991 // Number.MAX_SAFE_INTEGER = 2**53 - 1

const stateKey string = "state"

// Keeper maintains the link to data vstorage and exposes getter/setter methods for the various parts of the state machine
type Keeper struct {
	storeKey   sdk.StoreKey
	cdc        codec.Codec
	paramSpace paramtypes.Subspace

	accountKeeper    types.AccountKeeper
	bankKeeper       bankkeeper.Keeper
	vstorageKeeper   vstoragekeeper.Keeper
	feeCollectorName string

	// CallToController dispatches a message to the controlling process
	callToController func(ctx sdk.Context, str string) (string, error)
}

var _ types.SwingSetKeeper = &Keeper{}

// NewKeeper creates a new IBC transfer Keeper instance
func NewKeeper(
	cdc codec.Codec, key sdk.StoreKey, paramSpace paramtypes.Subspace,
	accountKeeper types.AccountKeeper, bankKeeper bankkeeper.Keeper,
	vstorageKeeper vstoragekeeper.Keeper, feeCollectorName string,
	callToController func(ctx sdk.Context, str string) (string, error),
) Keeper {

	// set KeyTable if it has not already been set
	if !paramSpace.HasKeyTable() {
		paramSpace = paramSpace.WithKeyTable(types.ParamKeyTable())
	}

	return Keeper{
		storeKey:         key,
		cdc:              cdc,
		paramSpace:       paramSpace,
		accountKeeper:    accountKeeper,
		bankKeeper:       bankKeeper,
		vstorageKeeper:   vstorageKeeper,
		feeCollectorName: feeCollectorName,
		callToController: callToController,
	}
}

// PushAction appends an action to the controller's action queue.  This queue is
// kept in the kvstore so that changes to it are properly reverted if the
// kvstore is rolled back.  By the time the block manager runs, it can commit
// its SwingSet transactions without fear of side-effecting the world with
// intermediate transaction state.
//
// The actionQueue's format is documented by `makeChainQueue` in
// `packages/cosmic-swingset/src/make-queue.js`.
func (k Keeper) PushAction(ctx sdk.Context, action vm.Jsonable) error {
	bz, err := json.Marshal(action)
	if err != nil {
		return err
	}

	// Get the current queue tail, defaulting to zero if its vstorage doesn't exist.
	tail, err := k.actionQueueIndex(ctx, "tail")
	if err != nil {
		return err
	}

	// JS uses IEEE 754 floats so avoid overflowing integers
	if tail == MaxUint53 {
		return errors.New("actionQueue overflow")
	}

	// Set the vstorage corresponding to the queue entry for the current tail.
	k.vstorageKeeper.SetStorage(ctx, vstoragetypes.StorageEntry{fmt.Sprintf("actionQueue.%d", tail), string(bz)})

	// Update the tail to point to the next available entry.
	k.vstorageKeeper.SetStorage(ctx, vstoragetypes.StorageEntry{"actionQueue.tail", fmt.Sprintf("%d", tail+1)})
	return nil
}

func (k Keeper) actionQueueIndex(ctx sdk.Context, name string) (uint64, error) {
	index := uint64(0)
	var err error
	indexEntry := k.vstorageKeeper.GetData(ctx, "actionQueue."+name)
	if indexEntry.IsPresent() {
		index, err = strconv.ParseUint(indexEntry.Value(), 10, 64)
	}
	return index, err
}

func (k Keeper) ActionQueueLength(ctx sdk.Context) (int32, error) {
	head, err := k.actionQueueIndex(ctx, "head")
	if err != nil {
		return 0, err
	}
	tail, err := k.actionQueueIndex(ctx, "tail")
	if err != nil {
		return 0, err
	}
	size := tail - head
	if size > math.MaxInt32 {
		return math.MaxInt32, nil
	}
	return int32(size), nil
}

// BlockingSend sends a message to the controller and blocks the Golang process
// until the response.  It is orthogonal to PushAction, and should only be used
// by SwingSet to perform block lifecycle events (BEGIN_BLOCK, END_BLOCK,
// COMMIT_BLOCK).
func (k Keeper) BlockingSend(ctx sdk.Context, action vm.Jsonable) (string, error) {
	bz, err := json.Marshal(action)
	if err != nil {
		return "", err
	}
	return k.callToController(ctx, string(bz))
}

func (k Keeper) GetParams(ctx sdk.Context) (params types.Params) {
	k.paramSpace.GetParamSet(ctx, &params)
	return params
}

func (k Keeper) SetParams(ctx sdk.Context, params types.Params) {
	k.paramSpace.SetParamSet(ctx, &params)
}

func (k Keeper) GetState(ctx sdk.Context) types.State {
	store := ctx.KVStore(k.storeKey)
	bz := store.Get([]byte(stateKey))
	state := types.State{}
	k.cdc.MustUnmarshal(bz, &state)
	return state
}

func (k Keeper) SetState(ctx sdk.Context, state types.State) {
	store := ctx.KVStore(k.storeKey)
	bz := k.cdc.MustMarshal(&state)
	store.Set([]byte(stateKey), bz)
}

// GetBeansPerUnit returns a map taken from the current SwingSet parameters from
// a unit (key) string to an unsigned integer amount of beans.
func (k Keeper) GetBeansPerUnit(ctx sdk.Context) map[string]sdk.Uint {
	params := k.GetParams(ctx)
	beansPerUnit := make(map[string]sdk.Uint, len(params.BeansPerUnit))
	for _, bpu := range params.BeansPerUnit {
		beansPerUnit[bpu.Key] = bpu.Beans
	}
	return beansPerUnit
}

func getBeansOwingPathForAddress(addr sdk.AccAddress) string {
	return StoragePathBeansOwing + "." + addr.String()
}

// GetBeansOwing returns the number of beans that the given address owes to
// the FeeAccount but has not yet paid.
func (k Keeper) GetBeansOwing(ctx sdk.Context, addr sdk.AccAddress) sdk.Uint {
	path := getBeansOwingPathForAddress(addr)
	entry := k.vstorageKeeper.GetData(ctx, path)
	if !entry.IsPresent() {
		return sdk.ZeroUint()
	}
	return sdk.NewUintFromString(entry.Value())
}

// SetBeansOwing sets the number of beans that the given address owes to the
// feeCollector but has not yet paid.
func (k Keeper) SetBeansOwing(ctx sdk.Context, addr sdk.AccAddress, beans sdk.Uint) {
	path := getBeansOwingPathForAddress(addr)
	k.vstorageKeeper.SetStorage(ctx, vstoragetypes.StorageEntry{path, beans.String()})
}

// ChargeBeans charges the given address the given number of beans.  It divides
// the beans into the number to debit immediately vs. the number to store in the
// beansOwing.
func (k Keeper) ChargeBeans(ctx sdk.Context, addr sdk.AccAddress, beans sdk.Uint) error {
	beansPerUnit := k.GetBeansPerUnit(ctx)

	wasOwing := k.GetBeansOwing(ctx, addr)
	nowOwing := wasOwing.Add(beans)

	// Actually debit immediately in integer multiples of the minimum debit, since
	// nowOwing must be less than the minimum debit.
	beansPerMinFeeDebit := beansPerUnit[types.BeansPerMinFeeDebit]
	remainderOwing := nowOwing.Mod(beansPerMinFeeDebit)
	beansToDebit := nowOwing.Sub(remainderOwing)

	// Convert the debit to coins.
	beansPerFeeUnitDec := sdk.NewDecFromBigInt(beansPerUnit[types.BeansPerFeeUnit].BigInt())
	beansToDebitDec := sdk.NewDecFromBigInt(beansToDebit.BigInt())
	feeUnitPrice := k.GetParams(ctx).FeeUnitPrice
	feeDecCoins := sdk.NewDecCoinsFromCoins(feeUnitPrice...).MulDec(beansToDebitDec).QuoDec(beansPerFeeUnitDec)

	// Charge the account immediately if they owe more than BeansPerMinFeeDebit.
	// NOTE: We assume that BeansPerMinFeeDebit is a multiple of BeansPerFeeUnit.
	feeCoins, _ := feeDecCoins.TruncateDecimal()
	if !feeCoins.IsZero() {
		err := k.bankKeeper.SendCoinsFromAccountToModule(ctx, addr, k.feeCollectorName, feeCoins)
		if err != nil {
			return err
		}
	}

	// Record the new owing value, whether we have debited immediately or not
	// (i.e. there is more owing than before, but not enough to debit).
	k.SetBeansOwing(ctx, addr, remainderOwing)
	return nil
}

// makeFeeMenu returns a map from power flag to its fee.  In the case of duplicates, the
// first one wins.
func makeFeeMenu(powerFlagFees []types.PowerFlagFee) map[string]sdk.Coins {
	feeMenu := make(map[string]sdk.Coins, len(powerFlagFees))
	for _, pff := range powerFlagFees {
		if _, ok := feeMenu[pff.PowerFlag]; !ok {
			feeMenu[pff.PowerFlag] = pff.Fee
		}
	}
	return feeMenu
}

var privilegedProvisioningCoins sdk.Coins = sdk.NewCoins(sdk.NewInt64Coin("provisionpass", 1))

func calculateFees(balances sdk.Coins, submitter, addr sdk.AccAddress, powerFlags []string, powerFlagFees []types.PowerFlagFee) (sdk.Coins, error) {
	fees := sdk.NewCoins()

	// See if we have the balance needed for privileged provisioning.
	if balances.IsAllGTE(privilegedProvisioningCoins) {
		// We do, and notably we don't deduct anything from the submitter.
		return fees, nil
	}

	if !submitter.Equals(addr) {
		return nil, fmt.Errorf("submitter is not the same as target address for fee-based provisioning")
	}

	if len(powerFlags) == 0 {
		return nil, fmt.Errorf("must specify powerFlags for fee-based provisioning")
	}

	// Collate the power flags into a map of power flags to the fee coins.
	feeMenu := makeFeeMenu(powerFlagFees)

	// Calculate the total fee according to that map.
	for _, powerFlag := range powerFlags {
		if fee, ok := feeMenu[powerFlag]; ok {
			fees = fees.Add(fee...)
		} else {
			return nil, fmt.Errorf("unrecognized powerFlag: %s", powerFlag)
		}
	}

	return fees, nil
}

func (k Keeper) ChargeForProvisioning(ctx sdk.Context, submitter, addr sdk.AccAddress, powerFlags []string) error {
	balances := k.bankKeeper.GetAllBalances(ctx, submitter)
	fees, err := calculateFees(balances, submitter, addr, powerFlags, k.GetParams(ctx).PowerFlagFees)
	if err != nil {
		return err
	}

	// Deduct the fee from the submitter.
	if fees.IsZero() {
		return nil
	}
	return k.bankKeeper.SendCoinsFromAccountToModule(ctx, submitter, k.feeCollectorName, fees)
}

// GetEgress gets the entire egress struct for a peer
func (k Keeper) GetEgress(ctx sdk.Context, addr sdk.AccAddress) types.Egress {
	path := StoragePathEgress + "." + addr.String()
	entry := k.vstorageKeeper.GetData(ctx, path)
	if !entry.IsPresent() {
		return types.Egress{}
	}

	var egress types.Egress
	err := json.Unmarshal([]byte(entry.Value()), &egress)
	if err != nil {
		panic(err)
	}

	return egress
}

// SetEgress sets the egress struct for a peer, and ensures its account exists
func (k Keeper) SetEgress(ctx sdk.Context, egress *types.Egress) error {
	path := StoragePathEgress + "." + egress.Peer.String()

	bz, err := json.Marshal(egress)
	if err != nil {
		return err
	}

	// FIXME: We should use just SetStorageAndNotify here, but solo needs legacy for now.
	k.vstorageKeeper.LegacySetStorageAndNotify(ctx, vstoragetypes.StorageEntry{path, string(bz)})

	// Now make sure the corresponding account has been initialised.
	if acc := k.accountKeeper.GetAccount(ctx, egress.Peer); acc != nil {
		// Account already exists.
		return nil
	}

	// Create an account object with the specified address.
	acc := k.accountKeeper.NewAccountWithAddress(ctx, egress.Peer)

	// Store it in the keeper (panics on error).
	k.accountKeeper.SetAccount(ctx, acc)

	// Tell we were successful.
	return nil
}

// Logger returns a module-specific logger.
func (k Keeper) Logger(ctx sdk.Context) log.Logger {
	return ctx.Logger().With("module", fmt.Sprintf("x/%s", types.ModuleName))
}

// GetMailbox gets the entire mailbox struct for a peer
func (k Keeper) GetMailbox(ctx sdk.Context, peer string) string {
	path := StoragePathMailbox + "." + peer
	return k.vstorageKeeper.GetData(ctx, path).Value()
}

// SetMailbox sets the entire mailbox struct for a peer
func (k Keeper) SetMailbox(ctx sdk.Context, peer string, mailbox string) {
	path := StoragePathMailbox + "." + peer
	// FIXME: We should use just SetStorageAndNotify here, but solo needs legacy for now.
	k.vstorageKeeper.LegacySetStorageAndNotify(ctx, vstoragetypes.StorageEntry{path, mailbox})
}

func (k Keeper) PathToEncodedKey(path string) []byte {
	return k.vstorageKeeper.PathToEncodedKey(path)
}

func (k Keeper) GetStoreName() string {
	return k.vstorageKeeper.GetStoreName()
}
