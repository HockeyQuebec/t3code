/**
 * HarnessDriver — `ProviderDriver` for Agent Harness workflow runs.
 *
 * The harness is not a chat runtime: one turn is one `agent-harness run`, and
 * the thing a user picks in the composer's model slot is a *workflow*. Model
 * lists in this app are static per provider instance and cannot vary per
 * project, so the workflow list lives in this driver's configuration and the
 * adapter re-validates the chosen workflow against the target repo's
 * `.agent-harness.toml` when the run actually starts.
 *
 * @module provider/Drivers/HarnessDriver
 */
import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
  TextGenerationError,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { HarnessCatalogService } from "../../harness/HarnessCatalog.ts";
import { resolveHarnessBinary } from "../../harness/HarnessBinary.ts";
import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { makeHarnessAdapter } from "../Layers/HarnessAdapter.ts";
import { HarnessSettings } from "@t3tools/contracts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { buildServerProvider } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import { buildUnavailableProviderSnapshot } from "../unavailableProviderSnapshot.ts";

const DRIVER_KIND = ProviderDriverKind.make("harness");
const DISPLAY_NAME = "Agent Harness";

/** The workflows a stock install ships with; overridable per instance. */
const DEFAULT_WORKFLOWS = [
  "evaluated_change",
  "vibe_code",
  "evaluated_review",
  "dual_agent",
  "composer_change",
  "model_council",
  "claude_team",
  "auto_claude",
  "auto_codex",
  "auto_cursor",
  "auto_claude_cursor",
  "auto_codex_cursor",
] as const;

/** A workflow's hand-written summary plus the two facts every workflow shares. */
interface WorkflowDescription {
  /** What the workflow does and which agent plays each role. */
  readonly summary: string;
  /** Providers whose CLIs the workflow's roles draw on, in the order they run. */
  readonly providers: ReadonlyArray<string>;
  /** Whether any role in the workflow is allowed to write to the worktree. */
  readonly editsFiles: boolean;
}

/**
 * Short, hand-written summaries for the workflows this repository's
 * `.agent-harness.toml` ships with — the picker has no per-project context to
 * derive these the way the harness settings panel does (see
 * `describeHarnessWorkflow`), so a workflow outside this list simply renders
 * without a tooltip rather than guessing at one.
 */
const WORKFLOW_DESCRIPTIONS: Readonly<Record<string, WorkflowDescription>> = {
  evaluated_change: {
    summary:
      "Sol writes the work order, Terra implements section by section under a Sonnet lead, Opus certifies the tested result.",
    providers: ["Claude", "Codex"],
    editsFiles: true,
  },
  vibe_code: {
    summary:
      "No work order. Terra implements the task freely end to end, a Sonnet lead repairs failures, Sol reviews.",
    providers: ["Claude", "Codex"],
    editsFiles: true,
  },
  evaluated_review: {
    summary:
      "A single read-only Opus pass that answers a question about the repo with cited evidence.",
    providers: ["Claude"],
    editsFiles: false,
  },
  dual_agent: {
    summary:
      "Haiku and Luna scout independently, Sol architects from their findings, Terra implements, Sonnet certifies, Opus reviews.",
    providers: ["Claude", "Codex"],
    editsFiles: true,
  },
  composer_change: {
    summary:
      "Cheap scouts research, Sol writes the work order, Cursor Composer implements it, a Sonnet lead certifies, Terra reviews.",
    providers: ["Claude", "Codex", "Cursor"],
    editsFiles: true,
  },
  model_council: {
    summary:
      "Classifies the task as routine, standard, or critical and routes it to the matching tier automatically.",
    providers: ["Claude", "Codex", "Cursor"],
    editsFiles: true,
  },
  claude_team: {
    summary:
      "Opus plans, a Haiku crew implements section by section, Sonnet leads certify each section, Opus certifies the result.",
    providers: ["Claude"],
    editsFiles: true,
  },
  auto_claude: {
    summary:
      "Classifies the task and routes it to a Sonnet or Opus tier — the single-provider shape of model_council.",
    providers: ["Claude"],
    editsFiles: true,
  },
  auto_codex: {
    summary:
      "Sol decides and never types, Luna does the bulk editing, a Terra lead certifies each section and repairs it, Sol certifies the result.",
    providers: ["Codex"],
    editsFiles: true,
  },
  auto_cursor: {
    summary:
      "Auto decides and reviews, Composer does all the typing, and a second Composer profile repairs rejected sections.",
    providers: ["Cursor"],
    editsFiles: true,
  },
  auto_claude_cursor: {
    summary:
      "Opus decides at both ends and never edits, Cursor Composer types, a Sonnet lead certifies each section.",
    providers: ["Claude", "Cursor"],
    editsFiles: true,
  },
  auto_codex_cursor: {
    summary:
      "Sol decides at both ends and never edits, Cursor Composer types, a Terra lead certifies each section.",
    providers: ["Codex", "Cursor"],
    editsFiles: true,
  },
};

/**
 * Composes the tooltip text shown for a workflow in the model picker: the
 * hand-written summary, then which providers it spends and whether any role
 * can write to the worktree — the two things a user picking a "model" here
 * cannot otherwise tell from the workflow's name.
 */
function describeWorkflowForPicker(entry: WorkflowDescription): string {
  const providerList = entry.providers.join(" + ");
  const editsLine = entry.editsFiles ? "Can edit files" : "Read-only — never edits";
  return `${entry.summary}\n\nProviders: ${providerList}\n${editsLine}`;
}

const MISSING_BINARY_REASON = "agent-harness not found; set AGENT_HARNESS_BIN or add it to PATH";

// The settings form and the harness control panel both write
// `providers.harness`, so the driver decodes that exact schema rather than a
// parallel one — a second definition here is how `binaryPath` would silently
// stop working.
export type HarnessDriverSettings = HarnessSettings;

/** `evaluated_change` → `Evaluated change`. */
export function humanizeWorkflowName(workflow: string): string {
  const words = workflow.replace(/[_-]+/g, " ").trim();
  if (words.length === 0) {
    return workflow;
  }
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export function harnessWorkflowModels(
  workflows: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  for (const workflow of workflows) {
    const slug = workflow.trim();
    if (slug.length === 0 || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const entry = WORKFLOW_DESCRIPTIONS[slug];
    models.push({
      slug,
      name: humanizeWorkflowName(slug),
      ...(entry ? { description: describeWorkflowForPicker(entry) } : {}),
      isCustom: false,
      capabilities: null,
    });
  }
  return models;
}

export type HarnessDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HarnessCatalogService
  | Path.Path;

const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

const unsupportedTextGeneration = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Agent Harness does not provide a text generation runtime.",
    }),
  );

const harnessTextGeneration: TextGeneration["Service"] = {
  generateCommitMessage: () => unsupportedTextGeneration("generateCommitMessage"),
  generatePrContent: () => unsupportedTextGeneration("generatePrContent"),
  generateBranchName: () => unsupportedTextGeneration("generateBranchName"),
  generateThreadTitle: () => unsupportedTextGeneration("generateThreadTitle"),
};

export const HarnessDriver: ProviderDriver<HarnessDriverSettings, HarnessDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: DISPLAY_NAME,
    supportsMultipleInstances: true,
  },
  configSchema: HarnessSettings,
  defaultConfig: (): HarnessDriverSettings => ({
    enabled: true,
    workflows: [...DEFAULT_WORKFLOWS],
    binaryPath: "",
    harnessHome: "",
    allowDirty: false,
    roleOverrides: {},
  }),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathModule = yield* Path.Path;
      const platform = yield* HostProcessPlatform;
      const hostEnvironment = yield* HostProcessEnvironment;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });

      const adapter = yield* makeHarnessAdapter({
        workflows: config.workflows,
        ...(config.binaryPath ? { binPath: config.binaryPath } : {}),
        ...(config.harnessHome ? { harnessHome: config.harnessHome } : {}),
        ...(config.allowDirty !== undefined ? { allowDirty: config.allowDirty } : {}),
        roleOverrides: config.roleOverrides,
        environment: processEnv,
        instanceId,
      });

      const models = harnessWorkflowModels(config.workflows);

      // Availability is re-derived on every read: a user who installs the
      // harness mid-session should not have to restart the server.
      const readSnapshot = Effect.gen(function* () {
        const binary = yield* resolveHarnessBinary({
          fileSystem,
          pathModule,
          pathEnv: processEnv.PATH ?? hostEnvironment.PATH ?? "",
          platform,
          ...(config.binaryPath || processEnv.AGENT_HARNESS_BIN !== undefined
            ? { override: config.binaryPath || processEnv.AGENT_HARNESS_BIN }
            : {}),
        });

        if (binary === null) {
          return yield* buildUnavailableProviderSnapshot({
            driverKind: DRIVER_KIND,
            instanceId,
            displayName: displayName ?? DISPLAY_NAME,
            ...(accentColor !== undefined ? { accentColor } : {}),
            reason: MISSING_BINARY_REASON,
          });
        }

        const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
        const draft = buildServerProvider({
          driver: DRIVER_KIND,
          presentation: {
            displayName: displayName ?? DISPLAY_NAME,
            requiresNewThreadForModelChange: true,
          },
          enabled,
          checkedAt,
          models,
          probe: {
            installed: true,
            version: null,
            status: "ready",
            // The harness holds no credentials: each workflow role signs in
            // through its own provider CLI. Reporting "unknown" here reads as
            // a broken sign-in and keeps the provider out of the model picker,
            // which filters on a fully ready instance.
            auth: {
              status: "authenticated",
              label: "Uses each provider's own sign-in",
            },
          },
        });

        return {
          ...draft,
          instanceId,
          driver: DRIVER_KIND,
          ...(accentColor ? { accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
          availability: "available",
        } satisfies ServerProvider;
      });

      const snapshot: ServerProviderShape = {
        resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
        getSnapshot: readSnapshot,
        refresh: readSnapshot,
        // Nothing about a harness instance changes on its own — the models are
        // configuration and availability is re-read on every snapshot.
        streamChanges: Stream.empty,
        // Harness runs are metered by the providers it drives, not by itself.
        applyUsageLimits: () => Effect.void,
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration: harnessTextGeneration,
      } satisfies ProviderInstance;
    }),
};
