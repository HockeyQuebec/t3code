/**
 * Reading a provider's remaining usage headroom, and when the window reopens.
 *
 * Every provider meters its own subscription, so a limit reading always
 * describes exactly one of them. Providers disagree about how many windows they
 * report and what to call them, so a reading here is normalised to a short
 * window (the one that usually binds) and a long one (the weekly-ish allowance
 * shown for context), each carrying its own length so the UI can label a Codex
 * weekly number honestly instead of writing "5h" over it.
 *
 * Everything in this module is pure. Locating and reading the files these
 * shapes come from is the server's job.
 */

/** How the numbers were come by, so the UI can say how much to trust them. */
export type AgentLimitSource = "statusline" | "providerSession" | "errorText" | "unknown";

export interface AgentLimitWindow {
  readonly usedPercent: number;
  /** Unix seconds, when the provider said. */
  readonly resetsAt: number | null;
  readonly windowMinutes: number | null;
}

export interface AgentLimitState {
  readonly short: AgentLimitWindow | null;
  readonly long: AgentLimitWindow | null;
  readonly source: AgentLimitSource;
  /** Unix seconds the reading was taken, not the moment it was parsed. */
  readonly observedAt: number | null;
}

export const EMPTY_LIMIT_STATE: AgentLimitState = {
  short: null,
  long: null,
  source: "unknown",
  observedAt: null,
};

/**
 * A window at or under this counts as the short, gating one. Anything longer is
 * the weekly-ish allowance.
 */
const SHORT_WINDOW_MINUTES = 24 * 60;

const CLAUDE_SHORT_WINDOW_MINUTES = 300;
const CLAUDE_LONG_WINDOW_MINUTES = 7 * 24 * 60;

/** A minute of slack so work resumes after the window flips, not on the second it does. */
export const RESET_BUFFER_SECONDS = 60;

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Claude Code's statusline hook tees its `rate_limits` object to disk, which
 * makes it the cheapest reading available: no process to run, and it is already
 * written by the time anyone asks.
 */
export function parseStatuslineLimits(raw: unknown): AgentLimitState {
  const record = asRecord(raw);
  if (record === null) {
    return EMPTY_LIMIT_STATE;
  }

  const readWindow = (value: unknown, windowMinutes: number): AgentLimitWindow | null => {
    const entry = asRecord(value);
    if (entry === null) {
      return null;
    }
    const usedPercent = finiteNumber(entry.used_percentage);
    if (usedPercent === null) {
      return null;
    }
    return { usedPercent, resetsAt: finiteNumber(entry.resets_at), windowMinutes };
  };

  const short = readWindow(record.five_hour, CLAUDE_SHORT_WINDOW_MINUTES);
  const long = readWindow(record.seven_day, CLAUDE_LONG_WINDOW_MINUTES);
  if (short === null && long === null) {
    return EMPTY_LIMIT_STATE;
  }

  return {
    short,
    long,
    source: "statusline",
    observedAt: finiteNumber(record.observed_at),
  };
}

/**
 * A Codex-shaped `rate_limits` block.
 *
 * Codex names its windows `primary` and `secondary`, but which is which moves
 * around — a weekly-only plan reports the weekly figure as `primary`. The
 * windows are therefore sorted by their stated length rather than trusted by
 * name.
 *
 * The app-server sends these camelCased while the session rollout files on disk
 * are snake_case, so both spellings are read for each field. A block may also
 * carry only one window: these updates are explicitly sparse, and a missing
 * window means "unchanged", not "zero" — see {@link mergeLimitState}.
 */
export function parseRateLimitsBlock(
  raw: unknown,
  source: AgentLimitSource = "providerSession",
  observedAt: number | null = null,
): AgentLimitState {
  const record = asRecord(raw);
  if (record === null) {
    return EMPTY_LIMIT_STATE;
  }

  let short: AgentLimitWindow | null = null;
  let long: AgentLimitWindow | null = null;

  for (const key of ["primary", "secondary"] as const) {
    const entry = asRecord(record[key]);
    if (entry === null) {
      continue;
    }
    const usedPercent = finiteNumber(entry.usedPercent ?? entry.used_percent);
    if (usedPercent === null) {
      continue;
    }

    const windowMinutes = finiteNumber(
      entry.windowDurationMins ?? entry.window_minutes ?? entry.windowMinutes,
    );
    const resetsAt = finiteNumber(entry.resetsAt ?? entry.resets_at);
    const isShort =
      windowMinutes !== null && windowMinutes > 0 && windowMinutes <= SHORT_WINDOW_MINUTES;
    const parsed = { usedPercent, resetsAt, windowMinutes };
    if (isShort) {
      short = parsed;
    } else {
      long = parsed;
    }
  }

  if (short === null && long === null) {
    return EMPTY_LIMIT_STATE;
  }
  return { short, long, source, observedAt };
}

/**
 * Claude's `rate_limit_event`, which reports one window at a time.
 *
 * The event names which window it describes rather than sending both, so a
 * caller keeping a running picture has to merge successive events — the Opus
 * and Sonnet weekly buckets both land in the long window, whichever arrives
 * last. `utilization` is a fraction rather than a percentage; a value above 1
 * is treated as an already-scaled percentage so a change of units upstream
 * degrades to a plausible number rather than a 0.6% reading on a full account.
 */
export function parseClaudeRateLimitInfo(
  raw: unknown,
  observedAt: number | null = null,
): AgentLimitState {
  const record = asRecord(raw);
  if (record === null) {
    return EMPTY_LIMIT_STATE;
  }
  // The adapter forwards the whole SDK message, so unwrap it when present.
  const info = asRecord(record.rate_limit_info) ?? record;

  const utilization = finiteNumber(info.utilization);
  if (utilization === null) {
    return EMPTY_LIMIT_STATE;
  }

  const window: AgentLimitWindow = {
    usedPercent: utilization <= 1 ? utilization * 100 : utilization,
    resetsAt: finiteNumber(info.resetsAt),
    windowMinutes: null,
  };

  const kind = typeof info.rateLimitType === "string" ? info.rateLimitType : "";
  const isShort = kind === "five_hour" || kind === "";
  return {
    short: isShort ? { ...window, windowMinutes: CLAUDE_SHORT_WINDOW_MINUTES } : null,
    long: isShort ? null : { ...window, windowMinutes: CLAUDE_LONG_WINDOW_MINUTES },
    source: "statusline",
    observedAt,
  };
}

/**
 * Fold a sparse update into the picture already held.
 *
 * Both providers send partial updates and expect the client to merge them, so a
 * window the update did not mention keeps its previous reading instead of being
 * blanked. A window whose own reset time has passed is dropped rather than
 * carried forward, which is what stops a header sticking at "97% used" on an
 * account that has since refilled.
 */
export function mergeLimitState(
  previous: AgentLimitState,
  incoming: AgentLimitState,
  nowSeconds: number,
): AgentLimitState {
  const keep = (
    next: AgentLimitWindow | null,
    old: AgentLimitWindow | null,
  ): AgentLimitWindow | null => {
    if (next !== null) {
      return next;
    }
    if (old === null || (old.resetsAt !== null && old.resetsAt <= nowSeconds)) {
      return null;
    }
    return old;
  };

  const short = keep(incoming.short, previous.short);
  const long = keep(incoming.long, previous.long);
  if (short === null && long === null) {
    return EMPTY_LIMIT_STATE;
  }

  return {
    short,
    long,
    source: incoming.source === "unknown" ? previous.source : incoming.source,
    observedAt: incoming.observedAt ?? previous.observedAt,
  };
}

/**
 * The window that actually constrains work right now.
 *
 * The short window normally decides. Some plans only report a long one — Codex
 * on a weekly-only limit does — and then that is the binding constraint, so it
 * stands in rather than the caller running blind.
 */
export function bindingWindow(state: AgentLimitState): AgentLimitWindow | null {
  return state.short ?? state.long;
}

/** Seconds until the binding window reopens, or null when nothing said. */
export function secondsToReset(state: AgentLimitState, nowSeconds: number): number | null {
  const resetsAt = bindingWindow(state)?.resetsAt ?? null;
  return resetsAt === null ? null : resetsAt - nowSeconds;
}

/**
 * Has the window this reading describes already reset?
 *
 * The statusline tee is only rewritten when Claude Code renders a statusline, so
 * a reading taken before a reset keeps reporting the finished window's spend
 * indefinitely. Once its own reset time has passed it says nothing about the
 * window in force now, which is how a header gets stuck at "97%" while the
 * account is in fact fresh.
 */
export function windowClosed(state: AgentLimitState, nowSeconds: number): boolean {
  const resetsAt = bindingWindow(state)?.resetsAt ?? null;
  return resetsAt !== null && resetsAt <= nowSeconds;
}

/** Unix seconds just after the binding window reopens, or null when it already has. */
export function nextResetEpoch(
  state: AgentLimitState,
  nowSeconds: number,
  bufferSeconds: number = RESET_BUFFER_SECONDS,
): number | null {
  const resetsAt = bindingWindow(state)?.resetsAt ?? null;
  if (resetsAt === null || resetsAt <= nowSeconds) {
    return null;
  }
  return resetsAt + bufferSeconds;
}

export type AgentLimitLevel = "unknown" | "fresh" | "normal" | "low" | "exhausted";

/**
 * How a reading should read to a user glancing at it: enough headroom to start
 * something big, enough to keep going, or time to stop.
 */
export function limitLevel(state: AgentLimitState): AgentLimitLevel {
  const window = bindingWindow(state);
  if (window === null) {
    return "unknown";
  }
  const headroom = 100 - window.usedPercent;
  if (headroom < 5) {
    return "exhausted";
  }
  if (headroom < 25) {
    return "low";
  }
  if (headroom >= 60) {
    return "fresh";
  }
  return "normal";
}

// Providers announce a limit in prose, and each phrases it differently. These
// are the last resort, used when a run fails and no telemetry file explains why.
const EPOCH_PATTERN = /(?:usage limit reached|resets?[_ ]at)\D{0,20}(\d{9,11})/i;
// "resets at 4:00am", "resets 3:40am (America/Indianapolis)", "will reset at
// 11pm" — "at" and the minutes are both optional, and a named zone in trailing
// parens is honoured, because the machine's clock is not always in the
// account's timezone.
const CLOCK_PATTERN =
  /resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z][\w+/-]*(?:\/[\w+/-]+)?)\))?/i;

interface ZoneWallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  /** How far the zone's wall clock runs ahead of UTC at this instant. */
  readonly offsetMs: number;
}

/**
 * What the wall clock in `zone` reads at an instant, and the zone's offset then.
 *
 * Null means the runtime does not know the zone, which is the only signal a
 * caller gets that a name pulled out of failure text was junk.
 */
function zoneWallClock(zone: string, epochMs: number): ZoneWallClock | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(epochMs);

    const field = (type: string): number => {
      const found = parts.find((part) => part.type === type)?.value;
      return found === undefined ? Number.NaN : Number(found);
    };

    const year = field("year");
    const month = field("month");
    const day = field("day");
    // Hour 24 is how some ICU builds render midnight under hour12: false.
    const hour = field("hour");
    const asUtc = Date.UTC(
      year,
      month - 1,
      day,
      hour === 24 ? 0 : hour,
      field("minute"),
      field("second"),
    );
    if (Number.isNaN(asUtc)) {
      return null;
    }
    return { year, month, day, offsetMs: asUtc - epochMs };
  } catch {
    return null; // not a zone this runtime knows
  }
}

/**
 * The next instant at which the wall clock in `zone` reads `hour:minute`.
 *
 * The offset is taken at the target rather than at now, which is what keeps a
 * time that lands on the far side of a DST boundary from being an hour out.
 */
function nextLocalTimeInZone(
  zone: string | null,
  hour: number,
  minute: number,
  nowMs: number,
): number | null {
  const resolved = zone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const wallNow = zoneWallClock(resolved, nowMs);
  if (wallNow === null) {
    return null;
  }

  // The target encoded as if the wall clock were UTC; subtracting the zone's
  // offset at that instant turns it back into a real epoch. Date.UTC rolls a
  // day past the end of the month over for us.
  const resolveDay = (dayOffset: number): number | null => {
    const wallTarget = Date.UTC(
      wallNow.year,
      wallNow.month - 1,
      wallNow.day + dayOffset,
      hour,
      minute,
    );
    const atTarget = zoneWallClock(resolved, wallTarget - wallNow.offsetMs);
    return atTarget === null ? null : wallTarget - atTarget.offsetMs;
  };

  const today = resolveDay(0);
  if (today === null) {
    return null;
  }
  return today > nowMs ? today : resolveDay(1);
}

/**
 * Recover a reset time from a provider's failure text.
 *
 * Returns null when nothing parses, so a caller holding better information —
 * the provider's own telemetry — can use that instead of a guess.
 */
export function parseResetEpochFromText(text: string, nowSeconds: number): number | null {
  const epochMatch = EPOCH_PATTERN.exec(text);
  if (epochMatch?.[1] !== undefined) {
    const epoch = Number(epochMatch[1]);
    // A plausible reset is near-future; anything else matched a version string
    // or an id that happened to be the right length.
    if (Number.isFinite(epoch) && epoch > nowSeconds - 3600 && epoch < nowSeconds + 8 * 3600) {
      return epoch;
    }
  }

  const clockMatch = CLOCK_PATTERN.exec(text);
  // A bare "resets 5" is a sentence fragment, not a time: insist on minutes or
  // an am/pm before believing it.
  if (clockMatch === null || (clockMatch[2] === undefined && clockMatch[3] === undefined)) {
    return null;
  }

  let hour = Number(clockMatch[1]);
  const minute = Number(clockMatch[2] ?? "0");
  const meridiem = clockMatch[3]?.toLowerCase();
  if (meridiem === "pm" && hour !== 12) {
    hour += 12;
  } else if (meridiem === "am" && hour === 12) {
    hour = 0;
  }
  if (!Number.isFinite(hour) || hour < 0 || hour > 23 || !Number.isFinite(minute)) {
    return null;
  }

  const epochMs = nextLocalTimeInZone(clockMatch[4] ?? null, hour, minute, nowSeconds * 1000);
  return epochMs === null ? null : Math.round(epochMs / 1000);
}

/** One Claude account as claude-swap (`cswap list --json`) reports it. */
export interface CswapAccountLimits {
  readonly number: number;
  readonly email: string;
  readonly active: boolean;
  readonly state: AgentLimitState;
}

function isoToEpochSeconds(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis / 1000 : null;
}

/**
 * claude-swap polls every account it manages, so it is the one place that
 * knows the headroom of the Claude accounts that are not running right now.
 */
export function parseCswapList(raw: unknown): ReadonlyArray<CswapAccountLimits> {
  const accounts = asRecord(raw)?.accounts;
  if (!Array.isArray(accounts)) {
    return [];
  }

  const readWindow = (value: unknown, windowMinutes: number): AgentLimitWindow | null => {
    const entry = asRecord(value);
    const usedPercent = finiteNumber(entry?.pct);
    if (entry === null || usedPercent === null) {
      return null;
    }
    return { usedPercent, resetsAt: isoToEpochSeconds(entry.resetsAt), windowMinutes };
  };

  return accounts.flatMap((value): ReadonlyArray<CswapAccountLimits> => {
    const account = asRecord(value);
    const number = finiteNumber(account?.number);
    if (account === null || number === null || typeof account.email !== "string") {
      return [];
    }
    const usage = asRecord(account.usage);
    const short = readWindow(usage?.fiveHour, CLAUDE_SHORT_WINDOW_MINUTES);
    const long = readWindow(usage?.sevenDay, CLAUDE_LONG_WINDOW_MINUTES);
    return [
      {
        number,
        email: account.email,
        active: account.active === true,
        state:
          short === null && long === null
            ? EMPTY_LIMIT_STATE
            : {
                short,
                long,
                source: "statusline",
                observedAt: isoToEpochSeconds(account.usageFetchedAt),
              },
      },
    ];
  });
}

/**
 * The last rate-limit reading in a Codex session log (`~/.codex/sessions`).
 *
 * Codex writes one on every `token_count` event, so the newest session file
 * says where the ChatGPT account stood before T3 Code saw any live event.
 */
export function parseCodexSessionLimits(jsonl: string): {
  readonly state: AgentLimitState;
  readonly planType: string | null;
} {
  const lines = jsonl.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || !line.includes('"rate_limits"')) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    const payload = asRecord(record?.payload);
    const rateLimits = asRecord(payload?.rate_limits);
    if (rateLimits === null) {
      continue;
    }
    const state = parseRateLimitsBlock(
      rateLimits,
      "providerSession",
      isoToEpochSeconds(record?.timestamp),
    );
    if (state === EMPTY_LIMIT_STATE) {
      continue;
    }
    return {
      state,
      planType: typeof rateLimits.plan_type === "string" ? rateLimits.plan_type : null,
    };
  }
  return { state: EMPTY_LIMIT_STATE, planType: null };
}

/** The subscription tier from `cursor-agent about`; Cursor exposes no usage meter locally. */
export function parseCursorAboutTier(text: string): string | null {
  const match = /Subscription Tier\s+(.+)/.exec(text);
  const tier = match?.[1]?.trim();
  return tier && tier.length > 0 ? tier : null;
}
