import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

/**
 * Agent Harness runs a multi-step workflow — plan, implement, test, review —
 * across several providers in an isolated worktree, instead of putting one
 * prompt to one agent. A repository declares its workflows in an
 * `.agent-harness.toml`; these shapes are what a client needs to show them and
 * pick one.
 */

/** One role in a workflow, and what it is allowed to spend. */
export const HarnessRole = Schema.Struct({
  name: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  /** `read` roles inspect, `write` roles may change the worktree. */
  mode: Schema.Literals(["read", "write", "unknown"]),
  model: Schema.Option(TrimmedNonEmptyString),
  reasoning: Schema.Option(TrimmedNonEmptyString),
  timeoutSeconds: Schema.Option(NonNegativeInt),
});
export type HarnessRole = typeof HarnessRole.Type;

export const HarnessWorkflowSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** Every driver the workflow's roles draw on, canonically ordered. */
  drivers: Schema.Array(ProviderDriverKind),
  /** The `provider,provider` key a repository's automatic route is named for. */
  providerKey: Schema.String,
  roles: Schema.Array(HarnessRole),
  /** Plain-language summary of what this workflow does, derived from its steps. */
  description: Schema.String,
  /** Node names in declared order, e.g. plan → implement → tests → review. */
  steps: Schema.Array(TrimmedNonEmptyString),
  stepCount: NonNegativeInt,
  /** True for the route this repository declares as automatic for its drivers. */
  recommended: Schema.Boolean,
});
export type HarnessWorkflowSummary = typeof HarnessWorkflowSummary.Type;

/**
 * Why no workflows are on offer, so the UI can say something better than an
 * empty list.
 */
export const HarnessUnavailableReason = Schema.Literals([
  "noConfig",
  "unreadableConfig",
  "binaryMissing",
]);
export type HarnessUnavailableReason = typeof HarnessUnavailableReason.Type;

export const HarnessCatalogInput = Schema.Struct({
  /** Directory to resolve the workflow config from; the git root is searched upward. */
  cwd: TrimmedNonEmptyString,
  /** Overrides where the global config is looked for beside the harness's state. */
  harnessHome: Schema.optional(TrimmedNonEmptyString),
});
export type HarnessCatalogInput = typeof HarnessCatalogInput.Type;

/**
 * Whether the workflows came from the checkout, from the global config that
 * serves every checkout, or from the two merged — the checkout's tables
 * winning by name over the global ones.
 */
export const HarnessConfigScope = Schema.Literals(["repository", "global", "merged"]);
export type HarnessConfigScope = typeof HarnessConfigScope.Type;

export const HarnessCatalog = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  /** The config file the workflows were read from. */
  configPath: Schema.Option(TrimmedNonEmptyString),
  configScope: Schema.Option(HarnessConfigScope),
  /** Resolved `agent-harness` executable, when one is installed. */
  binaryPath: Schema.Option(TrimmedNonEmptyString),
  workflows: Schema.Array(HarnessWorkflowSummary),
  unavailable: Schema.Option(HarnessUnavailableReason),
});
export type HarnessCatalog = typeof HarnessCatalog.Type;
