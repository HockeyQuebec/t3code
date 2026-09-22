/**
 * What a turn cost when the provider never said.
 *
 * Claude Code reports `total_cost_usd` at the end of a run, so its dollars are
 * fact. Codex and Cursor report token counts and nothing else, which leaves a
 * spend view reading $0.00 for them — not "cheap", just unpriced. Everything
 * here turns those token counts into a number that carries a label saying how
 * much of it is a guess.
 *
 * Rates are dollars per million tokens. A reported cost always wins over an
 * estimate, and the two are never merged silently: a record keeps whatever the
 * provider said alongside the modelled figure, so a total can be split back
 * apart.
 */

const MILLION = 1_000_000;

/** Numbers from the vendor's published price list. */
export const PUBLISHED = "published";
/** Numbers this project guessed. Shown as an estimate, never as fact. */
export const ASSUMED = "assumed";

export type RateSource = typeof PUBLISHED | typeof ASSUMED;

export interface TokenRate {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly source: RateSource;
  readonly note: string;
}

export interface TokenCounts {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/** Anthropic's published scheme: cache writes cost 1.25x input, reads 0.1x. */
function anthropic(input: number, output: number, note = ""): TokenRate {
  return {
    input,
    output,
    cacheRead: Math.round(input * 0.1 * 10_000) / 10_000,
    cacheWrite: Math.round(input * 1.25 * 10_000) / 10_000,
    source: PUBLISHED,
    note,
  };
}

/**
 * Matched as substrings of the model name, longest needle first, so
 * "claude-opus-5" finds "opus" rather than stopping at a shorter row that also
 * matches. Keep the needles minimal so a new point release prices itself
 * without an edit here.
 */
export const DEFAULT_RATES: Readonly<Record<string, TokenRate>> = {
  // Anthropic, published $/Mtok.
  fable: anthropic(10.0, 50.0),
  mythos: anthropic(10.0, 50.0),
  "opus-5-5": { ...anthropic(4.0, 20.0), cacheRead: 0.2 },
  opus: anthropic(5.0, 25.0),
  sonnet: anthropic(3.0, 15.0),
  haiku: anthropic(1.0, 5.0),

  // OpenAI via Codex: assumed, not verified. The GPT-5 family's last published
  // API pricing, carried forward. Codex bills cached input at a tenth and
  // charges nothing to write a cache, which is why the write column is 0.
  "gpt-5": {
    input: 1.25,
    output: 10.0,
    cacheRead: 0.125,
    cacheWrite: 0.0,
    source: ASSUMED,
    note: "GPT-5-family API list price, carried forward",
  },
  codex: {
    input: 1.25,
    output: 10.0,
    cacheRead: 0.125,
    cacheWrite: 0.0,
    source: ASSUMED,
    note: "GPT-5-family API list price, carried forward",
  },

  // Cursor publishes these input/output prices and Auto's cached-input price,
  // but no separate cache-write row, so cache writes are priced conservatively
  // as ordinary input. The `assumed` label keeps the mixed provenance visible.
  "composer-2.5-fast": {
    input: 3.0,
    output: 15.0,
    cacheRead: 3.0,
    cacheWrite: 3.0,
    source: ASSUMED,
    note: "Cursor published Fast input/output; cache priced conservatively",
  },
  "composer-2.5": {
    input: 0.5,
    output: 2.5,
    cacheRead: 0.5,
    cacheWrite: 0.5,
    source: ASSUMED,
    note: "Cursor published standard input/output; cache priced conservatively",
  },
  auto: {
    input: 1.25,
    output: 6.0,
    cacheRead: 0.25,
    cacheWrite: 1.25,
    source: ASSUMED,
    note: "Cursor published Auto input/output/cache-read; cache-write conservative",
  },
};

/**
 * When a turn never named a model — and Codex frequently doesn't — price it as
 * whatever that provider usually runs. Wrong-but-close beats a silent zero.
 */
const PROVIDER_FALLBACK: Readonly<Record<string, string>> = {
  claude: "sonnet",
  codex: "gpt-5",
  cursor: "auto",
};

/** Used when neither the model nor the provider is recognised at all. */
export const UNKNOWN_RATE: TokenRate = {
  input: 3.0,
  output: 15.0,
  cacheRead: 0.3,
  cacheWrite: 3.75,
  source: ASSUMED,
  note: "unrecognised model, priced as a mid-tier one",
};

export interface RateOverride {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly note?: string;
}

/**
 * The built-in table with a user's overrides layered over it.
 *
 * An override may set any subset of the four columns; the rest are kept from
 * the row it replaces. Overriding a published rate leaves it marked published —
 * you are correcting the number, not downgrading its provenance.
 */
export function mergeRateOverrides(
  overrides: Readonly<Record<string, RateOverride>> | undefined,
): Record<string, TokenRate> {
  const table: Record<string, TokenRate> = { ...DEFAULT_RATES };
  for (const [name, raw] of Object.entries(overrides ?? {})) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const key = name.toLowerCase();
    const base = table[key] ?? UNKNOWN_RATE;
    const columns: Record<string, number> = {};
    for (const column of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const value = raw[column];
      if (typeof value === "number" && Number.isFinite(value)) {
        columns[column] = value;
      }
    }
    if (Object.keys(columns).length === 0) {
      continue;
    }
    table[key] = { ...base, ...columns, note: raw.note ?? "set in settings" };
  }
  return table;
}

export interface ResolvedRate {
  readonly key: string;
  readonly rate: TokenRate;
}

/** The rate for a model name, falling back to the provider's usual one. */
export function rateFor(
  model: string | null | undefined,
  provider: string | null | undefined,
  table: Readonly<Record<string, TokenRate>> = DEFAULT_RATES,
): ResolvedRate {
  const lowered = (model ?? "").toLowerCase();

  // Cursor's model id is literally `auto`, so it is matched as an exact id.
  // Otherwise an unrelated future name containing that short word would be
  // silently costed as Cursor Auto.
  const exact = table[lowered];
  if (exact !== undefined) {
    return { key: lowered, rate: exact };
  }

  // Longest needle wins, so "gpt-5.6-sol" cannot match a shorter "gpt" row.
  const needles = Object.keys(table)
    .filter((key) => key.length > 0 && key !== "auto")
    .sort((left, right) => right.length - left.length);
  for (const key of needles) {
    if (lowered.includes(key)) {
      return { key, rate: table[key]! };
    }
  }

  const fallback = PROVIDER_FALLBACK[(provider ?? "").toLowerCase()];
  const fallbackRate = fallback === undefined ? undefined : table[fallback];
  if (fallback !== undefined && fallbackRate !== undefined) {
    return { key: fallback, rate: fallbackRate };
  }
  return { key: "unknown", rate: UNKNOWN_RATE };
}

export function rateCost(rate: TokenRate, tokens: TokenCounts): number {
  return (
    ((tokens.inputTokens ?? 0) * rate.input +
      (tokens.outputTokens ?? 0) * rate.output +
      (tokens.cacheReadTokens ?? 0) * rate.cacheRead +
      (tokens.cacheWriteTokens ?? 0) * rate.cacheWrite) /
    MILLION
  );
}

export type CostSource = "reported" | "estimated" | "none";

export interface PricedTurn {
  /** What the provider itself said, or 0 when it said nothing. */
  readonly reportedCostUsd: number;
  /** The modelled figure, filled in only when nobody priced the turn. */
  readonly estimatedCostUsd: number;
  readonly costSource: CostSource;
  readonly rateKey: string;
  readonly rateSource: RateSource;
}

/**
 * What one turn cost, and how much of that is a guess.
 *
 * The two cost columns never overlap, so summing them across turns cannot
 * double-count one that the provider already priced.
 */
export function priceTurn(
  input: TokenCounts & {
    readonly model?: string | null;
    readonly provider?: string | null;
    readonly reportedCostUsd?: number | null;
  },
  table: Readonly<Record<string, TokenRate>> = DEFAULT_RATES,
): PricedTurn {
  const reported =
    typeof input.reportedCostUsd === "number" && Number.isFinite(input.reportedCostUsd)
      ? input.reportedCostUsd
      : 0;
  const { key, rate } = rateFor(input.model, input.provider, table);
  const modelled = rateCost(rate, input);
  const priced = reported > 0;

  return {
    reportedCostUsd: reported,
    estimatedCostUsd: priced ? 0 : modelled,
    costSource: priced ? "reported" : modelled > 0 ? "estimated" : "none",
    rateKey: key,
    rateSource: rate.source,
  };
}

/** The rate rows actually used in a window, so a spend view can show its work. */
export function rateAssumptions(
  keys: Iterable<string>,
  table: Readonly<Record<string, TokenRate>> = DEFAULT_RATES,
): ReadonlyArray<{ readonly key: string } & TokenRate> {
  return [...new Set(keys)].sort().map((key) => ({ key, ...(table[key] ?? UNKNOWN_RATE) }));
}
