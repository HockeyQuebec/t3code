/**
 * Deciding whether a failed turn was a usage limit, and when to try it again.
 *
 * A long night of work dies the moment a subscription runs out: the turn fails
 * with a sentence about a limit, and everything queued behind it never runs.
 * The window always reopens, though, and the provider usually says when — so
 * the failure is a pause rather than an end, and the work can be written down
 * and re-sent once the window flips.
 *
 * Everything here is pure. Watching the event stream and queueing the resumed
 * turn is the server's job.
 */

import { parseResetEpochFromText, RESET_BUFFER_SECONDS } from "./agentLimits.ts";

/**
 * Phrases that mean "you are out of allowance", as each provider writes it.
 *
 * These have to be specific. A turn that merely mentioned rate limits in its
 * output must not be mistaken for one that hit one, so the patterns match the
 * shape of a refusal — a limit that was *reached*, an allowance *exceeded*, a
 * 429 — rather than the words "usage" or "limit" on their own.
 */
const LIMIT_PATTERNS: ReadonlyArray<RegExp> = [
  /usage limit reached/i,
  /you'?ve (?:reached|hit) your .{0,40}limit/i,
  /(?:rate|usage|quota|token) limit (?:reached|exceeded|hit)/i,
  /(?:weekly|daily|hourly|5-?hour|five-?hour) limit reached/i,
  /quota exceeded/i,
  /out of (?:credits|quota|tokens)/i,
  /insufficient (?:credits|quota)/i,
  /\brate[_ ]?limit(?:ed|_error|_exceeded)?\b/i,
  /\b429\b/,
  /resource[_ ]exhausted/i,
  /too many requests/i,
];

/**
 * Phrases that look like a limit but are not one this can wait out.
 *
 * A missing subscription or a rejected key does not fix itself at the top of
 * the hour, and re-sending the turn then would just fail again on a schedule.
 */
const NOT_A_LIMIT_PATTERNS: ReadonlyArray<RegExp> = [
  /invalid api key/i,
  /unauthori[sz]ed/i,
  /authentication (?:failed|required)/i,
  /\b401\b/,
  /payment (?:required|method)/i,
  /no (?:active )?subscription/i,
];

/**
 * Did this failure text describe a usage limit?
 *
 * False for anything empty or unrecognised: the cost of missing one is that a
 * turn stays failed and the user re-sends it, while the cost of a false
 * positive is a prompt the user did not ask for, sent hours later, into a
 * thread they may have moved on from.
 */
export function isUsageLimitFailure(text: string | null | undefined): boolean {
  if (typeof text !== "string" || text.trim().length === 0) {
    return false;
  }
  if (NOT_A_LIMIT_PATTERNS.some((pattern) => pattern.test(text))) {
    return false;
  }
  return LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Failures that are the job's own fault, and will be exactly as wrong later.
 *
 * These are checked before any retry pattern, because a message is allowed to
 * contain both — "500 Internal Server Error: invalid api key" is a rejected key
 * dressed up as a server fault, and re-sending it every minute all night would
 * do nothing but write the same failure into the thread sixty more times. When
 * one of these matches, nothing is queued at all.
 *
 * The user-cancellation entries are here for a different reason: pressing Stop
 * is a deliberate instruction to stop, and an automatic retry would read as the
 * machine arguing with the person driving it.
 */
const PERMANENT_PATTERNS: ReadonlyArray<RegExp> = [
  // Authentication and authorisation. A key that is rejected now is rejected
  // in fifteen minutes; a human has to go and fix it.
  /invalid api key/i,
  /\bapi key\b.{0,30}\b(?:invalid|missing|expired|revoked)\b/i,
  /unauthori[sz]ed/i,
  /\bforbidden\b/i,
  /permission denied/i,
  /authentication (?:failed|required|error)/i,
  /(?:token|credential|session) (?:has )?expired/i,
  /expired (?:token|credential|api key)/i,
  /\b40[13]\b/,
  // Malformed or rejected requests. The same bytes will be rejected again.
  /\b400\b/,
  /invalid[_ ]request/i,
  /bad request/i,
  /validation (?:failed|error)/i,
  /unsupported (?:model|parameter|option)/i,
  /\b404\b/,
  /not found/i,
  // Billing. Money does not appear on a timer.
  /payment (?:required|method|failed)/i,
  /billing/i,
  /no (?:active )?subscription/i,
  /insufficient funds/i,
  /credit balance is too low/i,
  // A user who stopped this on purpose is not asking for it back.
  /\b(?:aborted|cancell?ed|interrupted|stopped) by (?:the )?user\b/i,
  /user (?:aborted|cancell?ed|interrupted|stopped)/i,
  /\bcancell?ed\b/i,
];

/**
 * Failures where the work was fine and the machinery was not.
 *
 * A night-runner job dies far more often from a killed process, a dropped
 * socket, or a provider having a bad five minutes than from anything wrong with
 * the task. None of those are answered by leaving the job dead until morning,
 * and all of them are answered by trying again shortly.
 *
 * Everything here has to be specific enough that ordinary failure prose does
 * not match it: the default for unrecognised text is `permanent`, and that
 * default is doing real safety work.
 */
const TRANSIENT_PATTERNS: ReadonlyArray<RegExp> = [
  // The process died. For a harness run this is the whole failure: one turn is
  // one `agent-harness run`, and a dead process is the only symptom there is.
  /exit(?:ed)? (?:with )?(?:code|status) [1-9]/i,
  /non-?zero exit/i,
  /(?:process|worker|child|run) (?:was )?(?:died|crashed|killed|terminated)/i,
  /\bkilled\b/i,
  /\bSIG(?:KILL|TERM|SEGV|ABRT|BUS)\b/,
  /segmentation fault/i,
  /out of memory/i,
  /\bOOM(?:-?killed)?\b/,
  /heap out of memory/i,
  // The connection went away mid-flight.
  /\bE(?:CONNRESET|CONNREFUSED|CONNABORTED|TIMEDOUT|PIPE|AI_AGAIN|HOSTUNREACH|NETUNREACH|NETRESET)\b/,
  /socket hang ?up/i,
  /fetch failed/i,
  /network (?:error|failure|timeout)/i,
  /connection (?:reset|refused|closed|aborted|error|lost|timed out)/i,
  /\btimed out\b/i,
  /\btimeout\b/i,
  // The provider is up but unhappy. These say so in their own words, and they
  // are over within minutes.
  /\b(?:500|502|503|504|507|508|509|520|521|522|523|524|529)\b/,
  /internal server error/i,
  /bad gateway/i,
  /gateway time-?out/i,
  /service (?:is )?unavailable/i,
  /temporarily unavailable/i,
  /\boverloaded(?:_error)?\b/i,
  /server (?:error|is busy)/i,
  /try again later/i,
  // The stream stopped talking part-way through a turn.
  /stream (?:disconnected|closed|ended|interrupted|error|aborted)/i,
  /premature close/i,
  /unexpected end of (?:stream|input|json|output|file)/i,
  /connection to .{0,60} (?:lost|closed)/i,
];

/**
 * What kind of failure this was, and therefore what the server owes it.
 *
 * `usage-limit` is a pause with a known end: wait for the window and re-send.
 * `transient` is machinery: try again soon, with a growing gap. `permanent` is
 * everything else — including everything unrecognised — and gets nothing,
 * because the worst outcome available here is a job that re-sends itself all
 * night against a failure that was never going to fix itself.
 */
export type TurnFailureClass = "usage-limit" | "transient" | "permanent";

export function classifyTurnFailure(text: string | null | undefined): TurnFailureClass {
  if (typeof text !== "string" || text.trim().length === 0) {
    return "permanent";
  }
  // The limit check goes first only because it already carries its own
  // exclusions (`NOT_A_LIMIT_PATTERNS`), so it cannot claim an auth failure;
  // running it here keeps the existing behaviour bit-for-bit identical.
  if (isUsageLimitFailure(text)) {
    return "usage-limit";
  }
  // Permanent before transient, deliberately: a message that mentions both a
  // 5xx and a rejected key is a rejected key, and must not be retried.
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(text))) {
    return "permanent";
  }
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(text))) {
    return "transient";
  }
  return "permanent";
}

/**
 * The shortest gap before a crashed run is tried again.
 *
 * A minute is long enough for a killed process to be fully gone, a socket to be
 * re-dialled, and a provider's bad thirty seconds to be over, and short enough
 * that an unattended night loses almost nothing to the wait.
 */
export const TRANSIENT_RETRY_BASE_SECONDS = 60;

/**
 * The longest gap. Past a quarter of an hour the delay stops buying anything —
 * a fault that has survived fifteen minutes of backoff is not the kind that
 * clears on its own — and the low per-day cap will end the sequence shortly
 * anyway, so growing further would only waste the remaining attempts on sleep.
 */
export const TRANSIENT_RETRY_MAX_SECONDS = 15 * 60;

export interface TransientRetryAtInput {
  /** 1-based: how many automatic retries this thread has already been given. */
  readonly attempt: number;
  readonly nowSeconds: number;
}

/**
 * When to try a crashed run again.
 *
 * Doubling each time — one minute, two, four — so a job failing for a reason
 * that is not going away backs off instead of hammering the provider, while a
 * one-off dropped socket costs a single minute. Clamped at both ends so a
 * miscounted attempt cannot produce an instant retry loop or a delay measured
 * in hours.
 */
export function resolveTransientRetryAt(input: TransientRetryAtInput): {
  readonly atSeconds: number;
} {
  const attempt = Math.max(1, Math.floor(input.attempt));
  // Exponent capped before the shift so a large attempt count cannot overflow
  // into Infinity on its way to being clamped.
  const grown = TRANSIENT_RETRY_BASE_SECONDS * 2 ** Math.min(attempt - 1, 20);
  const delay = Math.min(
    Math.max(grown, TRANSIENT_RETRY_BASE_SECONDS),
    TRANSIENT_RETRY_MAX_SECONDS,
  );
  return { atSeconds: input.nowSeconds + delay };
}

/** Where a resume time came from, so the server can say so in the log and the UI. */
export type ResumeAtSource = "errorText" | "providerLimits" | "fallback";

export interface ResumeAt {
  /** Unix seconds to re-send at. */
  readonly atSeconds: number;
  readonly source: ResumeAtSource;
}

export interface ResolveResumeAtInput {
  /** The provider's failure sentence, which often names the reset time. */
  readonly failureText: string;
  /**
   * When the limit tracker last heard this provider's binding window reopens,
   * in unix seconds, or null when nothing has said.
   */
  readonly limitResetsAtSeconds: number | null;
  readonly nowSeconds: number;
  /**
   * Never re-send sooner than this. A provider that reports a reset time
   * already in the past — or a fallback of nothing — must not turn into a
   * retry every fifteen seconds.
   */
  readonly minimumDelaySeconds: number;
  /** Used when neither the text nor the tracker knows when the window reopens. */
  readonly fallbackDelaySeconds: number;
}

/**
 * When to re-send, and on whose authority.
 *
 * The failure text wins when it names a time, because it describes the limit
 * that actually just bit; the tracker's reading is a fallback because it may
 * describe the other window, or be minutes stale. Both are padded past the
 * stated reset so the resumed turn lands after the window flips rather than on
 * the second it does, and both are floored at `minimumDelaySeconds`.
 */
export function resolveResumeAt(input: ResolveResumeAtInput): ResumeAt {
  const floor = input.nowSeconds + Math.max(0, input.minimumDelaySeconds);

  const fromText = parseResetEpochFromText(input.failureText, input.nowSeconds);
  if (fromText !== null) {
    return { atSeconds: Math.max(fromText + RESET_BUFFER_SECONDS, floor), source: "errorText" };
  }

  const tracked = input.limitResetsAtSeconds;
  if (tracked !== null && tracked > input.nowSeconds) {
    return {
      atSeconds: Math.max(tracked + RESET_BUFFER_SECONDS, floor),
      source: "providerLimits",
    };
  }

  return {
    atSeconds: Math.max(input.nowSeconds + input.fallbackDelaySeconds, floor),
    source: "fallback",
  };
}

/**
 * How the interrupted work has to be re-sent.
 *
 * A conversational provider keeps the thread: its session resumes from its own
 * cursor, the agent still has everything that was said, and the resumed turn is
 * a nudge to carry on. A batch provider — Agent Harness — keeps nothing. One
 * turn there is one `agent-harness run` process, and that process is gone: the
 * only way to resume the job is to invoke the workflow again with the task it
 * was given, which means the task text has to be re-sent verbatim.
 */
export type ResumeKind = "conversation" | "batch";

export interface ResumePromptInput {
  readonly kind: ResumeKind;
  /**
   * Why the work stopped, which changes what the resumed prompt can honestly
   * claim. A usage limit has demonstrably reset by the time the resume fires;
   * a crash has not "reset" at all, and telling the agent it has would invite
   * it to assume the obstacle is gone. Defaults to `usage-limit` so existing
   * callers keep the wording they already had.
   */
  readonly reason?: TurnFailureClass;
  /**
   * The prompt the interrupted work started from. Required for `batch`, where
   * there is no session to continue and nothing else says what to do; ignored
   * for `conversation`, where re-stating it invites the agent to start over.
   */
  readonly originalTask: string | null;
  /** The worktree the interrupted run left its partial work in, when known. */
  readonly workspace: string | null;
  /** The workflow node the run died on, when the run got far enough to say. */
  readonly failedStep: string | null;
}

/**
 * What to send when the window reopens, or null when the work cannot be
 * described well enough to be worth re-sending.
 *
 * Both forms say explicitly not to start over. An agent handed a bare
 * "continue" after a gap will otherwise re-derive the whole plan and redo
 * finished work — which is exactly the spend the wait was meant to avoid.
 */
export function buildResumePrompt(input: ResumePromptInput): string | null {
  const transient = input.reason === "transient";

  if (input.kind === "conversation") {
    return [
      transient
        ? "Continue the work that was interrupted when the previous run stopped unexpectedly."
        : "Continue the work that was interrupted when the provider usage limit was reached.",
      transient
        ? "The failure looked environmental rather than something wrong with the task."
        : "The limit has since reset.",
      "Pick up exactly where you left off — do not start over, and do not redo work you already finished.",
      "If you are unsure how far you got, check the workspace state first.",
    ].join(" ");
  }

  const task = input.originalTask?.trim();
  if (task === undefined || task.length === 0) {
    // A harness run with no task text cannot be re-invoked: `agent-harness run`
    // takes the task as an argument, and there is no session to fall back on.
    return null;
  }

  const context: Array<string> = [
    transient
      ? "A previous run of this task stopped part-way through because the run itself failed unexpectedly."
      : "A previous run of this task stopped part-way through because a provider usage limit was reached.",
  ];
  if (input.failedStep !== null && input.failedStep.trim().length > 0) {
    context.push(`It got as far as the \`${input.failedStep.trim()}\` step.`);
  }
  context.push(
    transient
      ? "The failure looked environmental rather than something wrong with the task."
      : "The limit has since reset.",
  );
  if (input.workspace !== null && input.workspace.trim().length > 0) {
    context.push(
      `Partial work from that run is in ${input.workspace.trim()} — inspect it first and build on what is already done rather than repeating it.`,
    );
  }

  return `${context.join(" ")}\n\n${TASK_MARKER}\n\n${task}`;
}

/**
 * Where a batch resume prompt stops explaining itself and restates the task.
 * Exported only so the extraction below and the prompt above cannot drift.
 */
export const TASK_MARKER = "The task, unchanged:";

/**
 * The task inside a prompt, whether or not this feature wrote that prompt.
 *
 * A harness job can be cut short twice — a weekly window can close over a run
 * that a five-hour window already delayed — and the second resume reads the
 * first resume's prompt as its "original task". Without this, each interruption
 * would wrap the task in another layer of preamble until the real instruction
 * was buried.
 */
export function extractOriginalTask(prompt: string): string {
  const marker = prompt.lastIndexOf(TASK_MARKER);
  if (marker < 0) {
    return prompt.trim();
  }
  return prompt.slice(marker + TASK_MARKER.length).trim();
}

/** One already-queued resume, as much of it as this module needs to count. */
export interface QueuedResume {
  readonly threadId: string;
  readonly origin: string;
  readonly status: string;
  /** ISO 8601, as the scheduled-turn table stores it. */
  readonly createdAt: string;
}

export interface ResumeAllowanceInput {
  readonly threadId: string;
  /** Every scheduled turn the server knows about, resumes and user-queued alike. */
  readonly queued: ReadonlyArray<QueuedResume>;
  readonly nowMillis: number;
  /** How many automatic resumes one thread may get in a rolling day. */
  readonly maxPerDay: number;
  /**
   * Which automatic origin is being counted. Defaults to `usage-limit`, which
   * is what this used to count unconditionally.
   *
   * The two automatic origins are budgeted separately on purpose: a night that
   * legitimately spent six waits on a provider window has not shown that its
   * crash-retries are looping, and a job that crashed three times has not used
   * up its right to wait for the limit to reopen. Counting them together would
   * let either failure mode silently disable the other.
   */
  readonly origin?: string;
}

const DAY_MILLIS = 24 * 60 * 60 * 1000;

/** The origin stamped on turns queued because a provider window closed. */
export const USAGE_LIMIT_ORIGIN = "usage-limit";

/** The origin stamped on turns queued because the run itself fell over. */
export const AUTO_RETRY_ORIGIN = "auto-retry";

/**
 * May this thread have another automatic resume?
 *
 * Two things are being prevented. A resume still pending means the last one has
 * not even run yet, and queueing a second would double-send once the window
 * opens. A thread that has burned through its daily allowance is one where
 * resuming is not working — a weekly cap, a broken tool, an agent that fails
 * the same way every time — and the right answer there is to stop and let a
 * person look, not to keep spending the allowance on it.
 */
export function mayQueueResume(input: ResumeAllowanceInput): boolean {
  const origin = input.origin ?? USAGE_LIMIT_ORIGIN;
  const thisThread = input.queued.filter((turn) => turn.threadId === input.threadId);
  const mine = thisThread.filter((turn) => turn.origin === origin);

  // The pending check spans *both* automatic origins even though the cap does
  // not. Budgets are separate because they measure different problems, but
  // "something automatic is already queued for this thread" is one fact: a
  // crash-retry stacked on top of a waiting usage-limit resume would send the
  // same interrupted work twice. A turn the user queued themselves is not this
  // feature's to reason about and never blocks.
  const automatic = thisThread.filter(
    (turn) => turn.origin === USAGE_LIMIT_ORIGIN || turn.origin === AUTO_RETRY_ORIGIN,
  );
  if (automatic.some((turn) => turn.status === "pending")) {
    return false;
  }

  const since = input.nowMillis - DAY_MILLIS;
  const recent = mine.filter((turn) => {
    const created = Date.parse(turn.createdAt);
    // An unparseable timestamp counts against the cap: a row that cannot say
    // when it was made should not be the one that lets a loop through.
    return Number.isNaN(created) || created >= since;
  });
  return recent.length < input.maxPerDay;
}
