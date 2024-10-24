package gaia

import (
	"encoding/json"
	"fmt"
	"strings"
	"text/template"

	"github.com/Agoric/agoric-sdk/golang/cosmos/vm"
	swingsetkeeper "github.com/Agoric/agoric-sdk/golang/cosmos/x/swingset/keeper"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/module"
	upgradetypes "github.com/cosmos/cosmos-sdk/x/upgrade/types"
)

var upgradeNamesOfThisVersion = []string{
	"UNRELEASED_BASIC", // no-frills
	"UNRELEASED_A3P_INTEGRATION",
	"UNRELEASED_main",
	"UNRELEASED_devnet",
	"UNRELEASED_REAPPLY",
}

// isUpgradeNameOfThisVersion returns whether the provided plan name is a
// known upgrade name of this software version
func isUpgradeNameOfThisVersion(name string) bool {
	for _, upgradeName := range upgradeNamesOfThisVersion {
		if upgradeName == name {
			return true
		}
	}
	return false
}

// validUpgradeName is an identity function that asserts the provided name
// is an upgrade name of this software version. It can be used as a sort of
// dynamic enum check.
func validUpgradeName(name string) string {
	if !isUpgradeNameOfThisVersion(name) {
		panic(fmt.Errorf("invalid upgrade name: %s", name))
	}
	return name
}

// isPrimaryUpgradeName returns wether the provided plan name is considered a
// primary for the purpose of applying store migrations for the first upgrade
// of this version.
// It is expected that only primary plan names are used for non testing chains.
func isPrimaryUpgradeName(name string) bool {
	if name == "" {
		// An empty upgrade name can happen if there are no upgrade in progress
		return false
	}
	switch name {
	case validUpgradeName("UNRELEASED_BASIC"),
		validUpgradeName("UNRELEASED_A3P_INTEGRATION"),
		validUpgradeName("UNRELEASED_main"),
		validUpgradeName("UNRELEASED_devnet"):
		return true
	case validUpgradeName("UNRELEASED_REAPPLY"):
		return false
	default:
		panic(fmt.Errorf("unexpected upgrade name %s", validUpgradeName(name)))
	}
}

// isFirstTimeUpgradeOfThisVersion looks up in the upgrade store whether no
// upgrade plan name of this version have previously been applied.
func isFirstTimeUpgradeOfThisVersion(app *GaiaApp, ctx sdk.Context) bool {
	for _, name := range upgradeNamesOfThisVersion {
		if app.UpgradeKeeper.GetDoneHeight(ctx, name) != 0 {
			return false
		}
	}
	return true
}

func buildProposalStepWithArgs(moduleName string, entrypoint string, opts map[string]any) (vm.CoreProposalStep, error) {
	t := template.Must(template.New("").Parse(`{
		"module": "{{.moduleName}}",
		"entrypoint": "{{.entrypoint}}",
		"args": [ {{.args}} ]
	}`))

	args, err := json.Marshal(opts)
	if err != nil {
		return nil, err
	}

	var result strings.Builder
	err = t.Execute(&result, map[string]any{
		"moduleName": moduleName,
		"entrypoint": entrypoint,
		"args":       string(args),
	})
	if err != nil {
		return nil, err
	}
	jsonStr := result.String()
	jsonBz := []byte(jsonStr)
	if !json.Valid(jsonBz) {
		return nil, fmt.Errorf("invalid JSON: %s", jsonStr)
	}
	proposal := vm.ArbitraryCoreProposal{Json: jsonBz}
	return vm.CoreProposalStepForModules(proposal), nil
}

func getVariantFromUpgradeName(upgradeName string) string {
    switch upgradeName {
    case "UNRELEASED_A3P_INTEGRATION":
        return "A3P_INTEGRATION"
    case "UNRELEASED_main":
        return "MAINNET"
    case "UNRELEASED_devnet":
        return "DEVNET"
	// Noupgrade for this version.
    case "UNRELEASED_BASIC":
        return ""
    default:
        return ""
    }
}

func replaceElectorateCoreProposalStep(upgradeName string) (vm.CoreProposalStep, error) {
    variant := getVariantFromUpgradeName(upgradeName)

	return buildProposalStepWithArgs(
		"@agoric/builders/scripts/inter-protocol/replace-electorate-core.js",
		"defaultProposalBuilder",
		map[string]any{
			"variant": variant,
		},
	)
}

func replacePriceFeedsCoreProposal(upgradeName string) (vm.CoreProposalStep, error) {
    variant := getVariantFromUpgradeName(upgradeName)

	return buildProposalStepWithArgs(
		"@agoric/builders/scripts/inter-protocol/updatePriceFeeds.js",
		"defaultProposalBuilder",
		map[string]any{
			"variant": variant,
		},
	)
}

// unreleasedUpgradeHandler performs standard upgrade actions plus custom actions for the unreleased upgrade.
func unreleasedUpgradeHandler(app *GaiaApp, targetUpgrade string) func(sdk.Context, upgradetypes.Plan, module.VersionMap) (module.VersionMap, error) {
	return func(ctx sdk.Context, plan upgradetypes.Plan, fromVm module.VersionMap) (module.VersionMap, error) {
		app.CheckControllerInited(false)

		CoreProposalSteps := []vm.CoreProposalStep{}

		// These CoreProposalSteps are not idempotent and should only be executed
		// as part of the first upgrade using this handler on any given chain.
		if isFirstTimeUpgradeOfThisVersion(app, ctx) {
			// The storeUpgrades defined in app.go only execute for the primary upgrade name
			// If we got here and this first upgrade of this version does not use the
			// primary upgrade name, stores have not been initialized correctly.
			if !isPrimaryUpgradeName(plan.Name) {
				return module.VersionMap{}, fmt.Errorf("cannot run %s as first upgrade", plan.Name)
			}

			replaceElectorateStep, err := replaceElectorateCoreProposalStep(targetUpgrade)
			if err != nil {
				return nil, err
			}

			priceFeedUpdate, err := replacePriceFeedsCoreProposal(targetUpgrade)
			if err != nil {
				return nil, err
			}

			// Each CoreProposalStep runs sequentially, and can be constructed from
			// one or more modules executing in parallel within the step.
			CoreProposalSteps = []vm.CoreProposalStep{
				replaceElectorateStep,
				priceFeedUpdate,
				vm.CoreProposalStepForModules(
					"@agoric/builders/scripts/vats/add-auction.js",
				),
				vm.CoreProposalStepForModules(
					"@agoric/builders/scripts/vats/upgradeVaults.js",
				),
				vm.CoreProposalStepForModules(
					// Upgrade Zoe (no new ZCF needed).
					"@agoric/builders/scripts/vats/upgrade-zoe.js",
				),
				vm.CoreProposalStepForModules(
					// Upgrade to new liveslots for repaired vow usage.
					"@agoric/builders/scripts/vats/upgrade-orch-core.js",
				),
				vm.CoreProposalStepForModules(
					// Upgrade to new liveslots and support vows.
					"@agoric/builders/scripts/smart-wallet/build-wallet-factory2-upgrade.js",
				),
				vm.CoreProposalStepForModules(
					// Create vat-orchestration.
					"@agoric/builders/scripts/vats/init-orchestration.js",
				),
			}
		}

		app.upgradeDetails = &upgradeDetails{
			// Record the plan to send to SwingSet
			Plan: plan,
			// Core proposals that should run during the upgrade block
			// These will be merged with any coreProposals specified in the
			// upgradeInfo field of the upgrade plan ran as subsequent steps
			CoreProposals: vm.CoreProposalsFromSteps(CoreProposalSteps...),
		}

		// Always run module migrations
		mvm, err := app.mm.RunMigrations(ctx, app.configurator, fromVm)
		if err != nil {
			return mvm, err
		}

		m := swingsetkeeper.NewMigrator(app.SwingSetKeeper)
		err = m.MigrateParams(ctx)
		if err != nil {
			return mvm, err
		}

		return mvm, nil
	}
}
