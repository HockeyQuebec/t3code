import type { HarnessCatalog, HarnessCatalogInput } from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { HARNESS_BIN_ENV, resolveHarnessBinary, resolveHarnessHome } from "./HarnessBinary.ts";
import { resolveHarnessConfigSource } from "./HarnessConfigSource.ts";
import {
  normalizeHarnessConfig,
  providerKey,
  selectWorkflow,
  type HarnessWorkflow,
} from "@t3tools/shared/harnessWorkflow";
import { describeHarnessWorkflow, harnessWorkflowSteps } from "@t3tools/shared/harnessDescribe";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Simple TOML parser for agent-harness config files.
 * Supports: tables [a.b.c], key = value, strings, numbers, booleans, arrays of strings.
 * Not a full TOML parser — handles only the subset needed for .agent-harness.toml files.
 */
function parseToml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentTable: Record<string, unknown> = result;

  const lines = content.split("\n");

  for (const lineRaw of lines) {
    let line = lineRaw;

    // Remove comments
    const hashIdx = line.indexOf("#");
    if (hashIdx !== -1) {
      line = line.slice(0, hashIdx);
    }

    line = line.trim();

    if (!line) continue;

    // Handle table headers [section.subsection]
    if (line.startsWith("[")) {
      const endIdx = line.indexOf("]");
      if (endIdx === -1) continue;

      const tableName = line.slice(1, endIdx).trim();
      const parts = tableName.split(".").map((p) => p.trim());

      currentTable = result;

      // Navigate or create nested structure
      for (const part of parts) {
        if (!currentTable[part]) {
          currentTable[part] = {};
        }
        currentTable = currentTable[part] as Record<string, unknown>;
      }

      continue;
    }

    // Handle key = value
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    const valueStr = line.slice(eqIdx + 1).trim();

    const value = parseValue(valueStr);
    currentTable[key] = value;
  }

  return result;
}

function parseValue(valueStr: string): unknown {
  if (!valueStr) return "";

  // Parse strings
  if (valueStr.startsWith('"') && valueStr.endsWith('"')) {
    return valueStr.slice(1, -1).replace(/\\"/g, '"');
  }
  if (valueStr.startsWith("'") && valueStr.endsWith("'")) {
    return valueStr.slice(1, -1);
  }

  // Parse arrays [item1, item2, ...]
  if (valueStr.startsWith("[") && valueStr.endsWith("]")) {
    const inner = valueStr.slice(1, -1).trim();
    if (!inner) return [];

    return inner
      .split(",")
      .map((item) => {
        const trimmed = item.trim();
        if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
          return trimmed.slice(1, -1).replace(/\\"/g, '"');
        }
        if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
          return trimmed.slice(1, -1);
        }
        return trimmed;
      })
      .filter((item) => typeof item === "string" && item.length > 0);
  }

  // Parse booleans
  if (valueStr === "true") return true;
  if (valueStr === "false") return false;

  // Parse numbers
  const num = Number(valueStr);
  if (!isNaN(num)) return num;

  return valueStr;
}

export class HarnessCatalogService extends Context.Service<
  HarnessCatalogService,
  {
    readonly read: (input: HarnessCatalogInput) => Effect.Effect<HarnessCatalog>;
  }
>()("t3/harness/HarnessCatalog/HarnessCatalogService") {}

function makeService(
  fileSystem: FileSystem.FileSystem,
  pathModule: Path.Path,
  platform: NodeJS.Platform,
): HarnessCatalogService["Service"] {
  return {
    read: (input: HarnessCatalogInput) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const environment = yield* HostProcessEnvironment;

        const harnessHome = resolveHarnessHome({
          pathModule,
          environment,
          ...(input.harnessHome !== undefined ? { override: input.harnessHome } : {}),
        });

        // The global config and the repository's are merged, the repository
        // winning table by table; either alone is used as-is.
        const source = yield* resolveHarnessConfigSource({
          fileSystem,
          pathModule,
          environment,
          cwd: input.cwd,
          harnessHome,
        });

        if (source.kind === "none") {
          return {
            readAt: now,
            configPath: Option.none(),
            configScope: Option.none(),
            binaryPath: Option.none(),
            workflows: [],
            unavailable: Option.some("noConfig" as const),
          } satisfies HarnessCatalog;
        }

        if (source.kind === "unreadable") {
          return {
            readAt: now,
            configPath: Option.some(source.configPath),
            configScope: Option.none(),
            binaryPath: Option.none(),
            workflows: [],
            unavailable: Option.some("unreadableConfig" as const),
          } satisfies HarnessCatalog;
        }

        const configPath = source.configPath;
        const configScope = source.scope;

        // Parse TOML
        const parsed = yield* Effect.try(() => parseToml(source.toml)).pipe(
          Effect.orElseSucceed(() => ({}) as Record<string, unknown>),
        );

        // Normalize config
        const config = normalizeHarnessConfig(parsed);

        if (config.workflows.length === 0) {
          return {
            readAt: now,
            configPath: Option.some(configPath),
            configScope: Option.some(configScope),
            binaryPath: Option.none(),
            workflows: [],
            unavailable: Option.some("unreadableConfig" as const),
          } satisfies HarnessCatalog;
        }

        // Resolve agent-harness. A source checkout counts: the resolver
        // reports the PYTHONPATH its launcher needs rather than calling a
        // perfectly good checkout "not installed".
        const resolved = yield* resolveHarnessBinary({
          fileSystem,
          pathModule,
          pathEnv: environment.PATH ?? "",
          platform,
          ...(environment[HARNESS_BIN_ENV] !== undefined
            ? { override: environment[HARNESS_BIN_ENV] }
            : {}),
        });
        const binaryPath = resolved?.executable;

        // Map workflows to summaries
        const summaries = config.workflows.map((workflow: HarnessWorkflow) => {
          const driversArray = providerKey(workflow.providers)
            .split(",")
            .filter((d) => d.length > 0)
            .map((d) => ProviderDriverKind.make(d));

          const recommended =
            selectWorkflow(workflow.providers, config.workflows) === workflow.name;
          const stepCount = workflow.nodes?.length ?? 0;

          const roles = (workflow.nodes ?? []).flatMap((node) => {
            const agentNames = new Set<string>();

            if (node.agent) {
              agentNames.add(node.agent);
            }
            if (node.agents) {
              for (const agentName of node.agents) {
                agentNames.add(agentName);
              }
            }

            return Array.from(agentNames).map((agentName) => {
              const agent = config.agents.find((a) => a.name === agentName);

              return {
                name: agentName,
                driver: ProviderDriverKind.make(agent?.provider ?? ""),
                mode: (agent?.mode === "read" || agent?.mode === "write"
                  ? agent.mode
                  : "unknown") as "read" | "write" | "unknown",
                model: agent?.model ? Option.some(agent.model) : Option.none(),
                reasoning: agent?.reasoning ? Option.some(agent.reasoning) : Option.none(),
                timeoutSeconds: agent?.timeoutSeconds
                  ? Option.some(agent.timeoutSeconds)
                  : Option.none(),
              };
            });
          });

          // Deduplicate roles by name
          const uniqueRoles = new Map();
          for (const role of roles) {
            if (!uniqueRoles.has(role.name)) {
              uniqueRoles.set(role.name, role);
            }
          }

          return {
            name: workflow.name,
            drivers: driversArray,
            providerKey: providerKey(workflow.providers),
            roles: Array.from(uniqueRoles.values()),
            description: describeHarnessWorkflow(workflow, config.agents),
            steps: harnessWorkflowSteps(workflow),
            stepCount,
            recommended,
          };
        });

        return {
          readAt: now,
          configPath: Option.some(configPath),
          configScope: Option.some(configScope),
          binaryPath: binaryPath ? Option.some(binaryPath) : Option.none(),
          workflows: summaries,
          unavailable: Option.none(),
        } satisfies HarnessCatalog;
      }),
  };
}

const make = Effect.fn("t3/harness/HarnessCatalog/make")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathModule = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  return makeService(fileSystem, pathModule, platform);
});

export const layer = Layer.effect(HarnessCatalogService, make());
