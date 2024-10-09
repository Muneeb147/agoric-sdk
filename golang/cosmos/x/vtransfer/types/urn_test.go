package types_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/Agoric/agoric-sdk/golang/cosmos/x/vtransfer/types"
)

func TestExtractBaseAddress(t *testing.T) {
	bases := []struct {
		name string
		addr string
	}{
		{"agoric address", "agoric1abcdefghiteaneas"},
		{"cosmos address", "cosmos1abcdeffiharceuht"},
		{"hex address", "0xabcdef198189818c93839ibia"},
	}

	prefixes := []struct {
		prefix      string
		baseIsWrong bool
		isErr       bool
	}{
		{"", false, false},
		{"/", false, false},
		{"orch:/", false, false},
		{"unexpected", true, false},
		{"norch:/", false, true},
		{"orch:", false, true},
		{"norch:", false, true},
		{"\x01", false, true},
	}

	suffixes := []struct {
		suffix      string
		baseIsWrong bool
		isErr       bool
	}{
		{"", false, false},
		{"/", false, false},
		{"/sub/account", false, false},
		{"?query=something&k=v&k2=v2", false, false},
		{"?query=something&k=v&k2=v2#fragment", false, false},
		{"unexpected", true, false},
		{"\x01", false, true},
	}

	for _, b := range bases {
		b := b
		for _, p := range prefixes {
			p := p
			for _, s := range suffixes {
				s := s
				t.Run(b.name+" "+p.prefix+" "+s.suffix, func(t *testing.T) {
					addr := p.prefix + b.addr + s.suffix
					addr, err := types.ExtractBaseAddress(addr)
					if p.isErr || s.isErr {
						require.Error(t, err)
					} else {
						require.NoError(t, err)
						if p.baseIsWrong || s.baseIsWrong {
							require.NotEqual(t, b.addr, addr)
						} else {
							require.Equal(t, b.addr, addr)
						}
					}
				})
			}
		}
	}
}
