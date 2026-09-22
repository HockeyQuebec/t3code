// Normalize parsed .agent-harness.toml contents into typed workflow data.
// Pure TypeScript module - no filesystem, process spawning, or Effect.

const CANONICAL_PROVIDER_ORDER = ["claude", "codex", "cursor", "grok", "opencode"] as const;

export const WORKFLOW_CONFIG_NAMES = [
  ".agent-harness.toml",
  "agent-harness.toml",
  ".agent-harness/config.toml",
  ".config/agent-harness.toml",
] as const;

/**
 * Points at a workflow config to use when a repository declares none. Either a
 * file or a directory holding one of `WORKFLOW_CONFIG_NAMES`.
 */
export const HARNESS_CONFIG_ENV = "AGENT_HARNESS_CONFIG";

/**
 * Where to look for a workflow config that is not the repository's own.
 *
 * Workflows describe how a team wants work done, which is usually a property of
 * the person rather than of the checkout — so a config kept in one place should
 * serve every repository. A repository that declares its own config still wins;
 * these are only consulted when it does not.
 *
 * Ordered most to least explicit. Returns absolute candidate paths; the caller
 * decides which ones exist.
 */
export function globalHarnessConfigCandidates(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly harnessHome: string;
  readonly join: (...segments: readonly string[]) => string;
}): ReadonlyArray<string> {
  const { environment, harnessHome, join } = input;
  const candidates: string[] = [];
  const add = (path: string) => {
    if (path && !candidates.includes(path)) candidates.push(path);
  };

  // An explicit pointer wins, and may name either a file or a directory.
  const explicit = environment[HARNESS_CONFIG_ENV]?.trim();
  if (explicit) {
    add(explicit);
    for (const name of WORKFLOW_CONFIG_NAMES) add(join(explicit, name));
  }

  // Beside the harness's own state, so `runs/` and the workflows that produced
  // them live together.
  for (const name of WORKFLOW_CONFIG_NAMES) add(join(harnessHome, name));

  const xdg = environment.XDG_CONFIG_HOME?.trim();
  if (xdg) {
    add(join(xdg, "agent-harness", "config.toml"));
    add(join(xdg, "agent-harness.toml"));
  }

  const home = environment.HOME?.trim() ?? environment.USERPROFILE?.trim();
  if (home) {
    add(join(home, ".config", "agent-harness", "config.toml"));
    add(join(home, ".config", "agent-harness.toml"));
    add(join(home, ".agent-harness.toml"));
  }

  return candidates;
}

export type ProviderName = (typeof CANONICAL_PROVIDER_ORDER)[number];

// Canonical comma-joined provider id. Makes cursor,claude and claude,cursor produce the same key.
export function providerKey(providers: readonly string[] | string[] | Set<string>): string {
  const selected = new Set(providers);
  return CANONICAL_PROVIDER_ORDER.filter((name) => selected.has(name)).join(",");
}

// Workflow route ranking for selection priority.
function workflowRouteRank(workflow: {
  name: string;
  providers: readonly string[];
}): readonly [number, string] {
  const key = providerKey(workflow.providers);
  const automaticName = "auto_" + key.replace(/,/g, "_");
  const name = workflow.name;

  if (name === automaticName) {
    return [0, name] as const;
  }

  // model_council ranks 0 when its provider key is the full portfolio
  if (name === "model_council" && key === providerKey(CANONICAL_PROVIDER_ORDER)) {
    return [0, name] as const;
  }

  if (name === "evaluated_change") {
    return [1, name] as const;
  }

  return [2, name] as const;
}

// Select the best workflow for a given provider selection. Returns the workflow name or null if none found.
export function selectWorkflow(
  providers: readonly string[],
  workflows: ReadonlyArray<HarnessWorkflow>,
): string | null {
  const key = providerKey(providers);
  if (!key) return null;

  const candidates = workflows.filter((w) => providerKey(w.providers) === key);
  if (candidates.length === 0) return null;

  // Sort by rank, then by name for tie-breaking
  candidates.sort((a, b) => {
    const [rankA, nameA] = workflowRouteRank(a);
    const [rankB, nameB] = workflowRouteRank(b);
    if (rankA !== rankB) return rankA - rankB;
    return nameA.localeCompare(nameB);
  });

  return candidates[0]?.name ?? null;
}

// Agent role profile in the harness config
export interface HarnessAgentRole {
  readonly name: string;
  readonly provider: string;
  readonly mode: "read" | "write" | string;
  readonly model?: string | undefined;
  readonly reasoning?: string | undefined;
  readonly timeoutSeconds?: number | undefined;
  readonly allowedTools?: readonly string[] | undefined;
  readonly unsafeBypass?: boolean | undefined;
  readonly maxBudgetUsd?: number | undefined;
}

// A workflow node can be an agent, gate, command, judge, or fanout
export interface HarnessWorkflowNode {
  /** The table key, e.g. `plan` in `[workflows.x.nodes.plan]`. */
  readonly name: string;
  readonly kind: string;
  readonly agent?: string | undefined;
  readonly agents?: readonly string[] | undefined;
  readonly prompt?: string | undefined;
  readonly onSuccess?: string | undefined;
  readonly onFailure?: string | undefined;
  readonly command?: readonly string[] | undefined;
  readonly checks?: readonly Record<string, unknown>[] | undefined;
  readonly timeoutSeconds?: number | undefined;
  readonly maxVisits?: number | undefined;
  readonly [key: string]: unknown;
}

// A workflow definition
export interface HarnessWorkflow {
  readonly name: string;
  readonly providers: readonly string[];
  readonly entrypoint?: string | undefined;
  readonly workspace?: string | undefined;
  readonly baseRef?: string | undefined;
  readonly maxSteps?: number | undefined;
  readonly maxWallSeconds?: number | undefined;
  readonly nodes?: readonly HarnessWorkflowNode[] | undefined;
  readonly [key: string]: unknown;
}

// Complete harness config
export interface HarnessConfig {
  readonly version?: number | undefined;
  readonly agents: ReadonlyArray<HarnessAgentRole>;
  readonly workflows: ReadonlyArray<HarnessWorkflow>;
}

// Normalizer: takes an unknown parsed-TOML value and returns typed structures.
// Unknown/garbage input produces empty results, never throws.
export function normalizeHarnessConfig(value: unknown): HarnessConfig {
  if (!value || typeof value !== "object") {
    return { agents: [], workflows: [] };
  }

  const config = value as Record<string, unknown>;
  const version = typeof config.version === "number" ? config.version : undefined;

  // Normalize agents
  const agents: HarnessAgentRole[] = [];
  const rawAgents = config.agents;
  if (rawAgents && typeof rawAgents === "object" && !Array.isArray(rawAgents)) {
    for (const [name, rawAgent] of Object.entries(rawAgents)) {
      if (!rawAgent || typeof rawAgent !== "object" || Array.isArray(rawAgent)) {
        continue;
      }
      const agent = rawAgent as Record<string, unknown>;
      agents.push({
        name,
        provider: coerceString(agent.provider),
        mode: coerceString(agent.mode),
        model: coerceStringOrUndefined(agent.model),
        reasoning: coerceStringOrUndefined(agent.reasoning),
        timeoutSeconds: coerceNumberOrUndefined(agent.timeout_seconds),
        allowedTools: coerceStringArrayOrUndefined(agent.allowed_tools),
        unsafeBypass: agent.unsafe_bypass === true,
        maxBudgetUsd: coerceNumberOrUndefined(agent.max_budget_usd),
      });
    }
  }

  // Normalize workflows
  const workflows: HarnessWorkflow[] = [];
  const rawWorkflows = config.workflows;
  if (rawWorkflows && typeof rawWorkflows === "object" && !Array.isArray(rawWorkflows)) {
    for (const [name, rawWorkflow] of Object.entries(rawWorkflows)) {
      if (!rawWorkflow || typeof rawWorkflow !== "object" || Array.isArray(rawWorkflow)) {
        continue;
      }
      const workflow = rawWorkflow as Record<string, unknown>;

      // Extract agent names from nodes to determine providers
      const profileNames = new Set<string>();
      const rawNodes = workflow.nodes;
      const nodes: HarnessWorkflowNode[] = [];

      if (rawNodes && typeof rawNodes === "object" && !Array.isArray(rawNodes)) {
        for (const [nodeName, rawNode] of Object.entries(rawNodes)) {
          if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) {
            continue;
          }
          const node = rawNode as Record<string, unknown>;

          // Collect agent names
          if (typeof node.agent === "string") {
            profileNames.add(node.agent);
          }
          if (Array.isArray(node.agents)) {
            for (const agent of node.agents) {
              if (typeof agent === "string") {
                profileNames.add(agent);
              }
            }
          }

          nodes.push({
            name: nodeName,
            kind: coerceString(node.kind),
            agent: coerceStringOrUndefined(node.agent),
            agents: coerceStringArrayOrUndefined(node.agents),
            prompt: coerceStringOrUndefined(node.prompt),
            onSuccess: coerceStringOrUndefined(node.on_success),
            onFailure: coerceStringOrUndefined(node.on_failure),
            command: coerceStringArrayOrUndefined(node.command),
            checks: Array.isArray(node.checks) ? node.checks : undefined,
            timeoutSeconds: coerceNumberOrUndefined(node.timeout_seconds),
            maxVisits: coerceNumberOrUndefined(node.max_visits),
          });
        }
      }

      // Determine providers from agents that appear in this workflow
      const providers: string[] = [];
      for (const agentName of profileNames) {
        const agent = agents.find((a) => a.name === agentName);
        if (agent && agent.provider && !providers.includes(agent.provider)) {
          providers.push(agent.provider);
        }
      }

      workflows.push({
        name,
        providers: providers.sort(),
        entrypoint: coerceStringOrUndefined(workflow.entrypoint),
        workspace: coerceStringOrUndefined(workflow.workspace),
        baseRef: coerceStringOrUndefined(workflow.base_ref),
        maxSteps: coerceNumberOrUndefined(workflow.max_steps),
        maxWallSeconds: coerceNumberOrUndefined(workflow.max_wall_seconds),
        nodes: nodes.length > 0 ? nodes : undefined,
      });
    }
  }

  return {
    version,
    agents,
    workflows,
  };
}

// Type-narrowing helpers
function coerceString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function coerceStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function coerceNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && !isNaN(value) ? value : undefined;
}

function coerceStringArrayOrUndefined(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}
