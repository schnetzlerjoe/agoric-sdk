package keeper

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/Agoric/agoric-sdk/golang/cosmos/x/vstorage/capdata"
	"github.com/Agoric/agoric-sdk/golang/cosmos/x/vstorage/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
)

// Querier is used as Keeper will have duplicate methods if used directly, and gRPC names take precedence over keeper
type Querier struct {
	Keeper
}

var _ types.QueryServer = Querier{}

// ===================================================================
// /agoric.vstorage.Query/Data
// ===================================================================

// /agoric.vstorage.Query/Data returns data for a specified path.
func (k Querier) Data(c context.Context, req *types.QueryDataRequest) (*types.QueryDataResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "empty request")
	}
	ctx := sdk.UnwrapSDKContext(c)

	entry := k.GetEntry(ctx, req.Path)

	return &types.QueryDataResponse{
		Value: entry.StringValue(),
	}, nil
}

// ===================================================================
// /agoric.vstorage.Query/CapData
// ===================================================================

const (
	// Media types.
	JSONLines = "JSON Lines"

	// CapData transformation formats.
	FormatCapDataFlat = "flat"

	// CapData remotable value formats.
	FormatRemotableAsObject = "object"
	FormatRemotableAsString = "string"
)

var capDataResponseMediaTypes = map[string]string{
	JSONLines: JSONLines,
	// Default to JSON Lines.
	"": JSONLines,
}
var capDataTransformationFormats = map[string]string{
	FormatCapDataFlat: FormatCapDataFlat,
	// Default to no transformation.
	"": "",
}
var capDataRemotableValueFormats = map[string]string{
	FormatRemotableAsObject: FormatRemotableAsObject,
	FormatRemotableAsString: FormatRemotableAsString,
	// No default because both formats are lossy.
}

// flatten converts data into a flat structure in which each deep leaf entry is replaced with
// a top-level entry having the same value but a key generated by joining the keys on its path
// with separating dashes.
// For example,
// ```
// { "contacts": [
//
//	{ "name": "Alice", "email": "a@example.com" },
//	{ "name": "Bob", "email": "b@example.com" }
//
// ] }
// ```
// becomes
// ```
//
//	{
//	  "contacts-0-name": "Alice",
//	  "contacts-0-email": "a@example.com",
//	  "contacts-1-name": "Bob",
//	  "contacts-1-email": "b@example.com"
//	}
//
// ```
// cf. https://github.com/Agoric/agoric-sdk/blob/6e5b422b80e47c4dac151404f43faea5ab41e9b0/scripts/get-flattened-publication.sh
func flatten(input interface{}, output map[string]interface{}, key string, top bool) error {
	// Act on the raw representation of a Remotable.
	if remotable, ok := input.(*capdata.CapdataRemotable); ok {
		var replacement interface{}
		repr, err := capdata.JsonMarshal(remotable)
		if err == nil {
			err = json.Unmarshal(repr, &replacement)
		}
		if err != nil {
			return err
		}
		input = replacement
	}

	childKeyPrefix := key
	if !top {
		childKeyPrefix = childKeyPrefix + "-"
	}
	if arr, ok := input.([]interface{}); ok {
		for i, v := range arr {
			if err := flatten(v, output, childKeyPrefix+fmt.Sprintf("%d", i), false); err != nil {
				return err
			}
		}
	} else if obj, ok := input.(map[string]interface{}); ok {
		for k, v := range obj {
			if err := flatten(v, output, childKeyPrefix+k, false); err != nil {
				return err
			}
		}
	} else {
		if _, has := output[key]; has {
			return fmt.Errorf("key conflict: %q", key)
		}
		output[key] = input
	}
	return nil
}

// capdataBigintToDigits represents a bigint as a string consisting of
// an optional "-" followed by a sequence of digits with no extraneous zeroes
// (e.g., "0" or "-40").
func capdataBigintToDigits(bigint *capdata.CapdataBigint) interface{} {
	return bigint.Normalized
}

// capdataRemotableToString represents a Remotable as a bracketed string
// containing its alleged name and id from `slots`
// (e.g., "[Alleged: IST brand <board007>]").
func capdataRemotableToString(r *capdata.CapdataRemotable) interface{} {
	iface := "Remotable"
	if r.Iface != nil || *r.Iface != "" {
		iface = *r.Iface
	}
	return fmt.Sprintf("[%s <%s>]", iface, r.Id)
}

// capdataRemotableToObject represents a Remotable as an object containing
// its id from `slots` and its alleged name minus any "Alleged:" prefix
// (e.g., `{ "id": "board007", "allegedName": "IST brand" }`).
func capdataRemotableToObject(r *capdata.CapdataRemotable) interface{} {
	iface := "Remotable"
	if r.Iface != nil || *r.Iface != "" {
		iface = *r.Iface
		iface, _ = strings.CutPrefix(iface, "Alleged: ")
	}
	return map[string]interface{}{"id": r.Id, "allegedName": iface}
}

// /agoric.vstorage.Query/CapData returns data for a specified path,
// interpreted as CapData in a StreamCell (auto-promoting isolated CapData
// into a single-item StreamCell) and transformed as specified.
func (k Querier) CapData(c context.Context, req *types.QueryCapDataRequest) (*types.QueryCapDataResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "empty request")
	}
	ctx := sdk.UnwrapSDKContext(c)

	valueTransformations := capdata.CapdataValueTransformations{
		Bigint: capdataBigintToDigits,
	}

	// A response Value is "<prefix><separator-joined items><suffix>".
	prefix, separator, suffix := "", "\n", ""

	// Read options.
	mediaType, ok := capDataResponseMediaTypes[req.MediaType]
	if !ok {
		return nil, status.Error(codes.InvalidArgument, "invalid media_type")
	}
	transformation, ok := capDataTransformationFormats[req.ItemFormat]
	if !ok {
		return nil, status.Error(codes.InvalidArgument, "invalid item_format")
	}
	switch remotableFormat, ok := capDataRemotableValueFormats[req.RemotableValueFormat]; {
	case !ok:
		return nil, status.Error(codes.InvalidArgument, "invalid remotable_value_format")
	case remotableFormat == FormatRemotableAsObject:
		valueTransformations.Remotable = capdataRemotableToObject
	case remotableFormat == FormatRemotableAsString:
		valueTransformations.Remotable = capdataRemotableToString
	}

	// Read data, auto-upgrading a standalone value to a single-value StreamCell.
	entry := k.GetEntry(ctx, req.Path)
	if !entry.HasValue() {
		return nil, status.Error(codes.FailedPrecondition, "no data")
	}
	value := entry.StringValue()
	var cell StreamCell
	_ = json.Unmarshal([]byte(value), &cell)
	if cell.BlockHeight == "" {
		cell = StreamCell{Values: []string{value}}
	}

	// Format each StreamCell value.
	responseItems := make([]string, len(cell.Values))
	for i, capDataJson := range cell.Values {
		item, err := capdata.DecodeSerializedCapdata(capDataJson, valueTransformations)
		if err != nil {
			return nil, status.Error(codes.FailedPrecondition, err.Error())
		}
		if transformation == FormatCapDataFlat {
			flattened := map[string]interface{}{}
			if err := flatten(item, flattened, "", true); err != nil {
				return nil, status.Error(codes.Internal, err.Error())
			}
			// Replace the item, unless it was a scalar that "flattened" to `{ "": ... }`.
			if _, singleton := flattened[""]; !singleton {
				item = flattened
			}
		}
		switch mediaType {
		case JSONLines:
			jsonText, err := capdata.JsonMarshal(item)
			if err != nil {
				return nil, status.Error(codes.Internal, err.Error())
			}
			responseItems[i] = string(jsonText)
		}
	}

	return &types.QueryCapDataResponse{
		BlockHeight: cell.BlockHeight,
		Value:       prefix + strings.Join(responseItems, separator) + suffix,
	}, nil
}

// ===================================================================
// /agoric.vstorage.Query/Children
// ===================================================================

// /agoric.vstorage.Query/Children returns the list of path segments
// that exist immediately underneath a specified path, including
// those corresponding with "empty non-terminals" having children
// but no data of their own.
func (k Querier) Children(c context.Context, req *types.QueryChildrenRequest) (*types.QueryChildrenResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "empty request")
	}
	ctx := sdk.UnwrapSDKContext(c)

	children := k.GetChildren(ctx, req.Path)

	return &types.QueryChildrenResponse{
		Children: children.Children,
	}, nil
}
