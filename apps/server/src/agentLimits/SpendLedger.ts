import type {
  ProviderDriverKind,
  SpendEntry,
  SpendSummary,
  SpendSummaryInput,
  SpendWindow,
} from "@t3tools/contracts";
import {
  DEFAULT_RATES,
  priceTurn,
  rateAssumptions,
  type TokenRate,
} from "@t3tools/shared/tokenPricing";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ProviderService } from "../provider/Services/ProviderService.ts";

/**
 * What the night's work cost.
 *
 * Claude reports dollars, Codex and Cursor report only tokens, so a spend view
 * built on reported cost alone reads $0.00 for two thirds of the work — not
 * "cheap", just unpriced. Token counts are therefore priced from a rate table
 * and the modelled figure is carried *beside* the reported one, never merged
 * into it, so a total can always be split back into fact and estimate.
 *
 * The ledger lives in memory and starts when the server does. That is a real
 * limitation and the summary says so through `truncated` rather than implying a
 * partial total is the whole story.
 */
export class SpendLedger extends Context.Service<
  SpendLedger,
  {
    readonly summarize: (input: SpendSummaryInput) => Effect.Effect<SpendSummary>;
  }
>()("t3/agentLimits/SpendLedger") {}

interface LedgerRecord {
  readonly atMillis: number;
  readonly driver: ProviderDriverKind;
  readonly model: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly reportedCostUsd: number | null;
}

/**
 * Enough turns to cover a busy month of work while keeping the ledger's memory
 * bounded. The oldest records are dropped first, which is also what makes a
 * window that reaches past them `truncated`.
 */
const MAX_RECORDS = 50_000;

function windowStartMillis(window: SpendWindow, nowMillis: number): number | null {
  const day = 24 * 60 * 60 * 1000;
  switch (window) {
    case "today":
      return nowMillis - day;
    case "week":
      return nowMillis - 7 * day;
    case "month":
      return nowMillis - 30 * day;
    case "all":
      return null;
  }
}

interface Bucket {
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
  };
  reportedCostUsd: number;
  estimatedCostUsd: number;
  reported: number;
  estimated: number;
  turns: number;
  driver: ProviderDriverKind | null;
  model: string | null;
  rateKeys: Set<string>;
}

function newBucket(): Bucket {
  return {
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    reportedCostUsd: 0,
    estimatedCostUsd: 0,
    reported: 0,
    estimated: 0,
    turns: 0,
    driver: null,
    model: null,
    rateKeys: new Set(),
  };
}

function addToBucket(bucket: Bucket, record: LedgerRecord, table: Record<string, TokenRate>): void {
  bucket.tokens.inputTokens += record.inputTokens;
  bucket.tokens.outputTokens += record.outputTokens;
  bucket.tokens.cacheReadTokens += record.cacheReadTokens;
  bucket.tokens.cacheWriteTokens += record.cacheWriteTokens;
  bucket.tokens.reasoningTokens += record.reasoningTokens;
  bucket.turns += 1;
  bucket.driver ??= record.driver;
  bucket.model ??= record.model;

  const priced = priceTurn(
    {
      provider: record.driver,
      model: record.model,
      reportedCostUsd: record.reportedCostUsd,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadTokens: record.cacheReadTokens,
      cacheWriteTokens: record.cacheWriteTokens,
    },
    table,
  );
  bucket.reportedCostUsd += priced.reportedCostUsd;
  bucket.estimatedCostUsd += priced.estimatedCostUsd;
  bucket.rateKeys.add(priced.rateKey);
  if (priced.costSource === "reported") {
    bucket.reported += 1;
  } else if (priced.costSource === "estimated") {
    bucket.estimated += 1;
  }
}

function toEntry(key: string, bucket: Bucket): SpendEntry {
  const tokens = bucket.tokens;
  return {
    key,
    driver: bucket.driver === null ? Option.none() : Option.some(bucket.driver),
    model: bucket.model === null ? Option.none() : Option.some(bucket.model),
    tokens: {
      ...tokens,
      totalTokens:
        tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens,
    },
    reportedCostUsd: bucket.reportedCostUsd,
    estimatedCostUsd: bucket.estimatedCostUsd,
    // A window holding both kinds is neither: saying so keeps the two columns
    // from reading as one number that is partly a guess.
    costSource:
      bucket.reported > 0 && bucket.estimated > 0
        ? "mixed"
        : bucket.reported > 0
          ? "reported"
          : bucket.estimated > 0
            ? "estimated"
            : "none",
    turns: bucket.turns,
  } satisfies SpendEntry;
}

function finiteInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(Math.round(value), 0) : 0;
}

const make = () =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const startedAt = yield* DateTime.now;
    const records = yield* Ref.make<ReadonlyArray<LedgerRecord>>([]);
    const dropped = yield* Ref.make(false);

    const record = (entry: LedgerRecord) =>
      Ref.modify(records, (current) => {
        const next = [...current, entry];
        if (next.length <= MAX_RECORDS) {
          return [false, next] as const;
        }
        return [true, next.slice(next.length - MAX_RECORDS)] as const;
      }).pipe(Effect.flatMap((lost) => (lost ? Ref.set(dropped, true) : Effect.void)));

    // `lastUsedTokens` and friends describe the turn that just finished, which
    // is what a ledger adds up. The cumulative counters on the same payload
    // describe the whole thread and would double-count every turn.
    yield* providerService.streamEvents.pipe(
      Stream.runForEach((event) => {
        if (event.type !== "thread.token-usage.updated") {
          return Effect.void;
        }
        const usage = event.payload.usage;
        const input = finiteInt(usage.lastInputTokens);
        const output = finiteInt(usage.lastOutputTokens);
        const cacheRead = finiteInt(usage.lastCachedInputTokens);
        if (input + output + cacheRead === 0) {
          return Effect.void;
        }
        return DateTime.now.pipe(
          Effect.flatMap((now) =>
            record({
              atMillis: DateTime.toEpochMillis(now),
              driver: event.provider,
              model: null,
              // Codex counts cached reads inside its input total; subtracting
              // them keeps "fresh input" meaning the same thing for everyone.
              inputTokens: Math.max(input - cacheRead, 0),
              outputTokens: output,
              cacheReadTokens: cacheRead,
              cacheWriteTokens: 0,
              reasoningTokens: finiteInt(usage.lastReasoningOutputTokens),
              reportedCostUsd: null,
            }),
          ),
        );
      }),
      Effect.forkScoped,
    );

    const summarize: SpendLedger["Service"]["summarize"] = (input) =>
      Effect.gen(function* () {
        const readAt = yield* DateTime.now;
        const nowMillis = DateTime.toEpochMillis(readAt);
        const start = windowStartMillis(input.window, nowMillis);
        const all = yield* Ref.get(records);
        const lostRecords = yield* Ref.get(dropped);
        const selected = start === null ? all : all.filter((entry) => entry.atMillis >= start);

        const total = newBucket();
        const byDriver = new Map<string, Bucket>();
        const byModel = new Map<string, Bucket>();
        for (const entry of selected) {
          addToBucket(total, entry, DEFAULT_RATES);

          const driverBucket = byDriver.get(entry.driver) ?? newBucket();
          addToBucket(driverBucket, entry, DEFAULT_RATES);
          byDriver.set(entry.driver, driverBucket);

          const modelKey = entry.model ?? entry.driver;
          const modelBucket = byModel.get(modelKey) ?? newBucket();
          addToBucket(modelBucket, entry, DEFAULT_RATES);
          byModel.set(modelKey, modelBucket);
        }

        const spent = (entry: SpendEntry) => entry.reportedCostUsd + entry.estimatedCostUsd;
        const rank = (entries: ReadonlyArray<SpendEntry>) =>
          [...entries].sort((left, right) => spent(right) - spent(left));

        const startedAtMillis = DateTime.toEpochMillis(startedAt);
        return {
          readAt,
          window: input.window,
          since: Option.some(startedAt),
          // The window reaches back further than the ledger can answer for.
          truncated: lostRecords || (start !== null && start < startedAtMillis),
          total: toEntry("total", total),
          byDriver: rank([...byDriver].map(([key, bucket]) => toEntry(key, bucket))),
          byModel: rank([...byModel].map(([key, bucket]) => toEntry(key, bucket))),
          assumptions: rateAssumptions(total.rateKeys, DEFAULT_RATES).map((row) => ({
            key: row.key,
            input: row.input,
            output: row.output,
            cacheRead: row.cacheRead,
            cacheWrite: row.cacheWrite,
            source: row.source,
            note: row.note,
          })),
        } satisfies SpendSummary;
      });

    return { summarize } as const;
  });

export const layer = Layer.effect(SpendLedger, make());
