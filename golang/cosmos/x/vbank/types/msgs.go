package types

const RouterKey = ModuleName // this was defined in your key.go file

type VbankSingleBalanceUpdate struct {
	Address string `json:"address"`
	Denom   string `json:"denom"`
	Amount  string `json:"amount"`
}

type VbankBalanceUpdate struct {
	Type string `json:"type"`
	// BlockHeight defaults to sdk.Context.BlockHeight().
	BlockHeight int64 `json:"blockHeight,omitempty"`
	// BlockTime defaults to sdk.Context.BlockTime().Unix().
	BlockTime int64                      `json:"blockTime,omitempty"`
	Nonce     uint64                     `json:"nonce"`
	Updated   []VbankSingleBalanceUpdate `json:"updated"`
}
