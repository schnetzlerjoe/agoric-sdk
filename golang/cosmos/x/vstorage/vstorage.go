package vstorage

import (
	"encoding/json"
	"errors"
	"fmt"

	sdk "github.com/cosmos/cosmos-sdk/types"

	"github.com/Agoric/agoric-sdk/golang/cosmos/vm"
	"github.com/Agoric/agoric-sdk/golang/cosmos/x/vstorage/types"
)

type vstorageHandler struct {
	keeper Keeper
}

type vstorageMessage struct {
	Method string            `json:"method"`
	Args   []json.RawMessage `json:"args"`
}

type vstorageStoreKey struct {
	StoreName       string `json:"storeName"`
	StoreSubkey     string `json:"storeSubkey"`
	DataPrefixBytes string `json:"dataPrefixBytes"`
	NoDataValue     string `json:"noDataValue"`
}

func NewStorageHandler(keeper Keeper) vstorageHandler {
	return vstorageHandler{keeper: keeper}
}

func (sh vstorageHandler) Receive(cctx *vm.ControllerContext, str string) (ret string, err error) {
	keeper := sh.keeper
	msg := new(vstorageMessage)
	err = json.Unmarshal([]byte(str), &msg)
	if err != nil {
		return
	}

	// Allow recovery from OutOfGas panics so that we don't crash
	defer func() {
		if r := recover(); r != nil {
			switch rType := r.(type) {
			case sdk.ErrorOutOfGas:
				err = fmt.Errorf(
					"out of gas in location: %v; gasUsed: %d",
					rType.Descriptor, cctx.Context.GasMeter().GasConsumed(),
				)
			default:
				// Not ErrorOutOfGas, so panic again.
				panic(r)
			}
		}
	}()

	// Handle generic paths.
	switch msg.Method {
	case "set":
		for _, arg := range msg.Args {
			var entry types.StorageEntry
			entry, err = types.UnmarshalStorageEntry(arg)
			if err != nil {
				return
			}
			keeper.SetStorageAndNotify(cctx.Context, entry)
		}
		return "true", nil

		// We sometimes need to use LegacySetStorageAndNotify, because the solo's
		// chain-cosmos-sdk.js consumes legacy events for `mailbox.*` and `egress.*`.
		// FIXME: Use just "set" and remove this case.
	case "legacySet":
		for _, arg := range msg.Args {
			var entry types.StorageEntry
			entry, err = types.UnmarshalStorageEntry(arg)
			if err != nil {
				return
			}
			//fmt.Printf("giving Keeper.SetStorage(%s) %s\n", entry.Path(), entry.Value())
			keeper.LegacySetStorageAndNotify(cctx.Context, entry)
		}
		return "true", nil

	case "setWithoutNotify":
		for _, arg := range msg.Args {
			var entry types.StorageEntry
			entry, err = types.UnmarshalStorageEntry(arg)
			if err != nil {
				return
			}
			keeper.SetStorage(cctx.Context, entry)
		}
		return "true", nil

	case "append":
		for _, arg := range msg.Args {
			var entry types.StorageEntry
			entry, err = types.UnmarshalStorageEntry(arg)
			if err != nil {
				return
			}
			if !entry.HasData() {
				err = errors.New("No value for append entry with path: " + entry.Path())
				return
			}
			err = keeper.AppendStorageValueAndNotify(cctx.Context, entry.Path(), entry.StringValue())
			if err != nil {
				return "", err
			}
		}
		return "true", nil

	case "get":
		// Note that "get" does not (currently) unwrap a StreamCell.
		var path string
		err = json.Unmarshal(msg.Args[0], &path)
		if err != nil {
			return
		}

		entry := keeper.GetEntry(cctx.Context, path)
		if !entry.HasData() {
			return "null", nil
		}
		//fmt.Printf("Keeper.GetStorage gave us %bz\n", entry.Value())
		bz, err := json.Marshal(entry.StringValue())
		if err != nil {
			return "", err
		}
		return string(bz), nil

	case "getStoreKey":
		var path string
		err = json.Unmarshal(msg.Args[0], &path)
		if err != nil {
			return
		}
		value := vstorageStoreKey{
			StoreName:       keeper.GetStoreName(),
			StoreSubkey:     string(keeper.PathToEncodedKey(path)),
			DataPrefixBytes: string(keeper.GetDataPrefix()),
			NoDataValue:     string(keeper.GetNoDataValue()),
		}
		bz, err := json.Marshal(value)
		if err != nil {
			return "", err
		}
		return string(bz), nil

	case "has":
		var path string
		err = json.Unmarshal(msg.Args[0], &path)
		if err != nil {
			return
		}
		value := keeper.HasStorage(cctx.Context, path)
		if !value {
			return "false", nil
		}
		return "true", nil

	// TODO: "keys" is deprecated
	case "children", "keys":
		var path string
		err = json.Unmarshal(msg.Args[0], &path)
		if err != nil {
			return
		}
		children := keeper.GetChildren(cctx.Context, path)
		if children.Children == nil {
			return "[]", nil
		}
		bytes, err := json.Marshal(children.Children)
		if err != nil {
			return "", err
		}
		return string(bytes), nil

	case "entries":
		var path string
		err = json.Unmarshal(msg.Args[0], &path)
		if err != nil {
			return
		}
		children := keeper.GetChildren(cctx.Context, path)
		ents := make([][]string, len(children.Children))
		for i, child := range children.Children {
			ents[i] = make([]string, 2)
			ents[i][0] = child
			ents[i][i] = keeper.GetEntry(cctx.Context, fmt.Sprintf("%s.%s", path, child)).StringValue()
		}
		bytes, err := json.Marshal(ents)
		if err != nil {
			return "", err
		}
		return string(bytes), nil

	case "values":
		var path string
		err = json.Unmarshal(msg.Args[0], &path)
		if err != nil {
			return
		}
		children := keeper.GetChildren(cctx.Context, path)
		vals := make([]string, len(children.Children))
		for i, child := range children.Children {
			vals[i] = keeper.GetEntry(cctx.Context, fmt.Sprintf("%s.%s", path, child)).StringValue()
		}
		bytes, err := json.Marshal(vals)
		if err != nil {
			return "", err
		}
		return string(bytes), nil

	case "size":
		var path string
		err = json.Unmarshal(msg.Args[0], &path)
		if err != nil {
			return
		}
		children := keeper.GetChildren(cctx.Context, path)
		if children.Children == nil {
			return "0", nil
		}
		return fmt.Sprint(len(children.Children)), nil
	}

	return "", errors.New("Unrecognized msg.Method " + msg.Method)
}
