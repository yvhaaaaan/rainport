package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Fabric's native external builder hooks dispatch by executable name. The peer
// launches the ChaincodeServer using the connection information in the release.
func run(args []string) error {
	if len(args) < 3 {
		return fmt.Errorf("missing builder arguments")
	}
	stage := strings.TrimSuffix(filepath.Base(args[0]), ".exe")
	switch stage {
	case "detect":
		data, err := os.ReadFile(filepath.Join(args[2], "metadata.json"))
		if err != nil {
			return err
		}
		var metadata struct{ Type string }
		if err := json.Unmarshal(data, &metadata); err != nil {
			return err
		}
		if metadata.Type != "ccaas" {
			return fmt.Errorf("unsupported chaincode type %q", metadata.Type)
		}
		return nil
	case "build":
		if len(args) != 4 {
			return fmt.Errorf("missing build output directory")
		}
		return copyConnection(args[1], args[3])
	case "release":
		return copyConnection(args[1], filepath.Join(args[2], "chaincode", "server"))
	default:
		return fmt.Errorf("unsupported builder stage %q", stage)
	}
}

func copyConnection(source, dest string) error {
	data, err := os.ReadFile(filepath.Join(source, "connection.json"))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dest, 0700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dest, "connection.json"), data, 0600)
}

func main() {
	if err := run(os.Args); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
