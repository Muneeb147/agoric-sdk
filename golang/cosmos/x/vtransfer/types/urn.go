package types

import (
	"fmt"
	"net/url"
	"strings"
)

const ParameterizedAddressScheme = "orch"

// ExtractBaseAddress extracts the base address from a parameterized address
// encoded as a URN.
func ExtractBaseAddressFromURN(relativeURN, scheme string) (string, error) {
	relativeTo := url.URL{Scheme: scheme}

	u, err := relativeTo.Parse(relativeURN)
	if err != nil {
		return "", err
	}

	if u.Scheme != scheme {
		return "", fmt.Errorf("unsupported address scheme %s", u.Scheme)
	}

	splits := strings.SplitN(u.Path, "/", 3)
	if len(splits) < 2 || splits[0] != "" {
		return "", fmt.Errorf("base address path must have at least one leading slash, not %s", u.Path)
	}

	base := splits[1]
	if len(base) == 0 {
		return "", fmt.Errorf("base address cannot be empty")
	}

	return base, nil
}

// ExtractBaseAddress extracts the base address from a parameterized address.
func ExtractBaseAddress(fullAddr string) (string, error) {
	return ExtractBaseAddressFromURN(fullAddr, ParameterizedAddressScheme)
}
