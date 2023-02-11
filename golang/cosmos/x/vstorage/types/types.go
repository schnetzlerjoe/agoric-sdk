package types

func NewData() *Data {
	return &Data{}
}

func NewChildren() *Children {
	return &Children{}
}

type StorageEntry []string

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
