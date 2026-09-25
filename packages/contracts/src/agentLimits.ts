import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * How a reading was come by, so a client can say how much to trust it.
 *
 * `providerSession` is the provider's own live telemetry, `statusline` a tee it
 * writes for a status line, and `errorText` a reset time recovered from a
 * failure message when nothing better was available.
 */
export const AgentLimitSource = Schema.Literals([
  "statusline",
  "providerSession",
  "errorText",
  "unknown",
]);
export type AgentLimitSource = typeof AgentLimitSource.Type;

/** How a reading should read to someone glancing at it. */
export const AgentLimitLevel = Schema.Literals(["unknown", "fresh", "normal", "low", "exhausted"]);
export type AgentLimitLevel = typeof AgentLimitLevel.Type;

/**
 * One metered window. `windowMinutes` is carried so a client can label a weekly
 * number honestly rather than assuming everyone meters in five-hour blocks.
 */
export const AgentLimitWindow = Schema.Struct({
  usedPercent: Schema.Number,
  resetsAt: Schema.Option(Schema.DateTimeUtc),
  windowMinutes: Schema.Option(NonNegativeInt),
});
export type AgentLimitWindow = typeof AgentLimitWindow.Type;

/**
 * What one provider instance has left.
 *
 * Limits are metered per subscription, not per driver, so two Claude accounts
 * configured as separate instances get a row each.
 */
export const ProviderLimitSnapshot = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  label: TrimmedNonEmptyString,
  /** A second line for the row: which account is active, or the plan tier. */
  detail: Schema.optional(TrimmedNonEmptyString),
  /** The claude-swap slot this row reads, so a client can offer to switch to it. */
  cswapAccount: Schema.optional(NonNegativeInt),
  /** True for the claude-swap account new Claude sessions currently run on. */
  active: Schema.optional(Schema.Boolean),
  /** The window that usually binds. */
  short: Schema.Option(AgentLimitWindow),
  /** The weekly-ish allowance, shown for context. */
  long: Schema.Option(AgentLimitWindow),
  /** Whichever of the two actually constrains work right now. */
  binding: Schema.Option(AgentLimitWindow),
  level: AgentLimitLevel,
  source: AgentLimitSource,
  observedAt: Schema.Option(Schema.DateTimeUtc),
});
export type ProviderLimitSnapshot = typeof ProviderLimitSnapshot.Type;

export const AgentLimitsSnapshot = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  providers: Schema.Array(ProviderLimitSnapshot),
});
export type AgentLimitsSnapshot = typeof AgentLimitsSnapshot.Type;

export const SwitchClaudeAccountInput = Schema.Struct({
  cswapAccount: NonNegativeInt,
});
export type SwitchClaudeAccountInput = typeof SwitchClaudeAccountInput.Type;

export const SwitchClaudeAccountResult = Schema.Struct({
  switched: Schema.Boolean,
});
export type SwitchClaudeAccountResult = typeof SwitchClaudeAccountResult.Type;

/** Where a spend total came from, kept split so the two never double-count. */
export const SpendCostSource = Schema.Literals(["reported", "estimated", "none", "mixed"]);
export type SpendCostSource = typeof SpendCostSource.Type;

export const SpendTokens = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  cacheWriteTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
  totalTokens: NonNegativeInt,
});
export type SpendTokens = typeof SpendTokens.Type;

/**
 * One row of the spend ledger.
 *
 * `reportedCostUsd` is whatever the provider itself charged; `estimatedCostUsd`
 * is filled in only where nobody priced the work, so the two columns can be
 * added without counting a priced turn twice.
 */
export const SpendEntry = Schema.Struct({
  key: TrimmedNonEmptyString,
  driver: Schema.Option(ProviderDriverKind),
  model: Schema.Option(TrimmedNonEmptyString),
  tokens: SpendTokens,
  reportedCostUsd: Schema.Number,
  estimatedCostUsd: Schema.Number,
  costSource: SpendCostSource,
  turns: NonNegativeInt,
});
export type SpendEntry = typeof SpendEntry.Type;

/** A rate row a spend view used, so it can show its work. */
export const SpendRateAssumption = Schema.Struct({
  key: TrimmedNonEmptyString,
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  source: Schema.Literals(["published", "assumed"]),
  note: Schema.String,
});
export type SpendRateAssumption = typeof SpendRateAssumption.Type;

export const SpendWindow = Schema.Literals(["today", "week", "month", "all"]);
export type SpendWindow = typeof SpendWindow.Type;

export const SpendSummaryInput = Schema.Struct({
  window: SpendWindow,
});
export type SpendSummaryInput = typeof SpendSummaryInput.Type;

/**
 * Spend over a window.
 *
 * `since` is the earliest turn the server can still account for, which is when
 * it started: the ledger lives in memory, so a restart is a gap and the UI has
 * to be able to say so rather than implying the total is the whole story.
 */
export const SpendSummary = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  window: SpendWindow,
  since: Schema.Option(Schema.DateTimeUtc),
  /** True when the window starts before the server did, so the total is partial. */
  truncated: Schema.Boolean,
  total: SpendEntry,
  byDriver: Schema.Array(SpendEntry),
  byModel: Schema.Array(SpendEntry),
  assumptions: Schema.Array(SpendRateAssumption),
});
export type SpendSummary = typeof SpendSummary.Type;

/**
 * What this device ran on one metered account.
 *
 * Percentages are estimates: a meter rise is split across this device's turns
 * by cost, and a rise no local turn explains is `other*` (another device on the
 * same account). The `window*` and percent figures cover the current window.
 */
export const AccountUsageEntry = Schema.Struct({
  account: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  turns: NonNegativeInt,
  tokens: NonNegativeInt,
  costUsd: Schema.Number,
  windowTurns: NonNegativeInt,
  windowTokens: NonNegativeInt,
  windowCostUsd: Schema.Number,
  fiveHourPercent: Schema.Number,
  weeklyPercent: Schema.Number,
  otherFiveHourPercent: Schema.Number,
  otherWeeklyPercent: Schema.Number,
});
export type AccountUsageEntry = typeof AccountUsageEntry.Type;

export const AccountUsageSnapshot = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  /** The oldest turn still on record. */
  since: Schema.Option(Schema.DateTimeUtc),
  accounts: Schema.Array(AccountUsageEntry),
});
export type AccountUsageSnapshot = typeof AccountUsageSnapshot.Type;

export const ThreadUsageInput = Schema.Struct({ threadId: ThreadId });
export type ThreadUsageInput = typeof ThreadUsageInput.Type;

/** One chat's share of an account. `windowFiveHourPercent` is the current 5h window only. */
export const ThreadAccountUsage = Schema.Struct({
  account: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  turns: NonNegativeInt,
  tokens: SpendTokens,
  costUsd: Schema.Number,
  fiveHourPercent: Schema.Number,
  windowFiveHourPercent: Schema.Number,
  weeklyPercent: Schema.Number,
});
export type ThreadAccountUsage = typeof ThreadAccountUsage.Type;

export const ThreadUsageSnapshot = Schema.Struct({
  threadId: ThreadId,
  turns: NonNegativeInt,
  tokens: SpendTokens,
  costUsd: Schema.Number,
  fiveHourPercent: Schema.Number,
  windowFiveHourPercent: Schema.Number,
  weeklyPercent: Schema.Number,
  byAccount: Schema.Array(ThreadAccountUsage),
});
export type ThreadUsageSnapshot = typeof ThreadUsageSnapshot.Type;
