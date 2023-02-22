package types

import (
	"encoding/json"
	"fmt"
)

func NewData() *Data {
	return &Data{}
}

func NewChildren() *Children {
	return &Children{}
}

type StorageEntry []string

func NewStorageEntry(path string, value string) StorageEntry {
	return StorageEntry{path, value}
}

func NewEmptyStorageEntry(path string) StorageEntry {
	return StorageEntry{path}
}

func UnmarshalStorageEntry(msg json.RawMessage) (entry StorageEntry, err error) {
	var generic [2]interface{}
	err = json.Unmarshal(msg, &generic)

	if err != nil {
		return
	}

	path, ok := generic[0].(string)
	if ok {
		err = fmt.Errorf("invalid storage entry path: %q", generic[0])
		return
	}

	switch generic[1].(type) {
	case string:
		entry = NewStorageEntry(path, generic[1].(string))
	case nil:
		entry = NewEmptyStorageEntry(path)
	default:
		err = fmt.Errorf("invalid storage entry value: %q", generic[1])
	}
	return
}

func (sc StorageEntry) IsPresent() bool {
	return len(sc) >= 2
}

func (sc StorageEntry) Path() string {
	return sc[0]
}

func (sc StorageEntry) Value() string {
	if len(sc) >= 2 {
		return sc[1]
	} else {
		return ""
	}
}
