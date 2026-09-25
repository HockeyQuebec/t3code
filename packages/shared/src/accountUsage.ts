/**
 * Which chat on this device used how much of which subscription.
 *
 * Providers meter a subscription as a percentage per window and never say
 * which request moved it, and claude-swap reads that meter for every account
 * but cannot tell this device's turns from anyone else's. So each time a meter
 * rises, the rise is split across the turns this device ran on that account
 * since the last reading, weighted by what each turn cost. A rise with no
 * local turn behind it belongs to another device using the same account.
 *
 * Meters only move in whole percents and lag the turn that moved them, so a
 * finished turn stays open for a grace period to collect the rise that lands
 * after it, and a rise that lands while a turn is still running waits in a
 * pool until that turn finishes and has a cost to weigh it by.
 */

/** Long enough for claude-swap's two-minute poll to see a finished turn. */
export const ATTRIBUTION_GRACE_MS = 6 * 60 * 1000;

/** A reset moves `resetsAt` by hours; clock jitter moves it by milliseconds. */
const SAME_WINDOW_TOLERANCE_MS = 5 * 60 * 1000;

export interface UsageMeter {
  readonly usedPercent: number;
  /** Epoch millis, when the provider said. */
  readonly resetsAt: number | null;
}

export interface AccountReading {
  readonly atMillis: number;
  readonly fiveHour: UsageMeter | null;
  readonly weekly: UsageMeter | null;
}

export interface UsageTurn {
  readonly id: string;
  readonly threadId: string;
  readonly account: string;
  readonly driver: string;
  readonly model: string | null;
  readonly atMillis: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  /** Share of the account's 5h meter this turn is estimated to have used. */
  readonly fiveHourPercent: number;
  /** The 5h window that share was drawn from, so "this window" can be summed. */
  readonly fiveHourResetsAt: number | null;
  readonly weeklyPercent: number;
  readonly weeklyResetsAt: number | null;
  /** Still collecting rises that land after it finished. */
  readonly open: boolean;
}

export interface AccountAttribution {
  readonly last: AccountReading | null;
  /** Rises seen while a turn was still running, waiting for its cost. */
  readonly pendingFiveHour: number;
  readonly pendingWeekly: number;
  /** Rises no turn on this device explains, per window. */
  readonly otherFiveHour: number;
  readonly otherFiveHourResetsAt: number | null;
  readonly otherWeekly: number;
  readonly otherWeeklyResetsAt: number | null;
}

export const EMPTY_ATTRIBUTION: AccountAttribution = {
  last: null,
  pendingFiveHour: 0,
  pendingWeekly: 0,
  otherFiveHour: 0,
  otherFiveHourResetsAt: null,
  otherWeekly: 0,
  otherWeeklyResetsAt: null,
};

export function sameWindow(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= SAME_WINDOW_TOLERANCE_MS;
}

/** How far a meter rose between two readings; a reset starts counting from zero. */
function rise(previous: UsageMeter | null, next: UsageMeter | null): number {
  if (next === null) return 0;
  if (previous === null) return 0;
  if (!sameWindow(previous.resetsAt, next.resetsAt)) {
    return Math.max(next.usedPercent, 0);
  }
  return Math.max(next.usedPercent - previous.usedPercent, 0);
}

/**
 * Folds one meter reading for `account` into the attribution state and the
 * turns it ran. `running` is whether a turn on that account is mid-flight.
 */
export function attributeReading(input: {
  readonly state: AccountAttribution;
  readonly turns: ReadonlyArray<UsageTurn>;
  readonly account: string;
  readonly reading: AccountReading;
  readonly running: boolean;
}): { readonly state: AccountAttribution; readonly turns: ReadonlyArray<UsageTurn> } {
  const { state, reading } = input;
  // The first reading after startup is only a baseline.
  const fiveHourRise = state.last === null ? 0 : rise(state.last.fiveHour, reading.fiveHour);
  const weeklyRise = state.last === null ? 0 : rise(state.last.weekly, reading.weekly);
  const poolFiveHour = state.pendingFiveHour + fiveHourRise;
  const poolWeekly = state.pendingWeekly + weeklyRise;
  const next = { ...state, last: reading };

  if (input.running) {
    return {
      state: { ...next, pendingFiveHour: poolFiveHour, pendingWeekly: poolWeekly },
      turns: input.turns,
    };
  }

  const open = input.turns.filter((turn) => turn.account === input.account && turn.open);
  if (open.length === 0) {
    const fiveHourResetsAt = reading.fiveHour?.resetsAt ?? null;
    const weeklyResetsAt = reading.weekly?.resetsAt ?? null;
    return {
      state: {
        ...next,
        pendingFiveHour: 0,
        pendingWeekly: 0,
        otherFiveHour:
          (sameWindow(state.otherFiveHourResetsAt, fiveHourResetsAt) ? state.otherFiveHour : 0) +
          poolFiveHour,
        otherFiveHourResetsAt: fiveHourResetsAt,
        otherWeekly:
          (sameWindow(state.otherWeeklyResetsAt, weeklyResetsAt) ? state.otherWeekly : 0) +
          poolWeekly,
        otherWeeklyResetsAt: weeklyResetsAt,
      },
      turns: input.turns,
    };
  }

  const totalCost = open.reduce((sum, turn) => sum + turn.costUsd, 0);
  const totalTokens = open.reduce((sum, turn) => sum + turnTokens(turn), 0);
  // Cost is the better weight, but an unpriced model still used the meter.
  const weight = (turn: UsageTurn) =>
    totalCost > 0
      ? turn.costUsd / totalCost
      : totalTokens > 0
        ? turnTokens(turn) / totalTokens
        : 1 / open.length;
  const openIds = new Set(open.map((turn) => turn.id));
  const turns = input.turns.map((turn) => {
    if (!openIds.has(turn.id)) return turn;
    const share = weight(turn);
    return {
      ...turn,
      fiveHourPercent: turn.fiveHourPercent + poolFiveHour * share,
      fiveHourResetsAt: reading.fiveHour?.resetsAt ?? turn.fiveHourResetsAt,
      weeklyPercent: turn.weeklyPercent + poolWeekly * share,
      weeklyResetsAt: reading.weekly?.resetsAt ?? turn.weeklyResetsAt,
      open: reading.atMillis - turn.atMillis < ATTRIBUTION_GRACE_MS,
    };
  });
  return { state: { ...next, pendingFiveHour: 0, pendingWeekly: 0 }, turns };
}

export function turnTokens(turn: {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}): number {
  return turn.inputTokens + turn.outputTokens + turn.cacheReadTokens + turn.cacheWriteTokens;
}

/** A window whose reset time has passed reads as empty, whatever the cache says. */
export function currentPercent(meter: UsageMeter | null, nowMillis: number): number {
  if (meter === null) return 0;
  if (meter.resetsAt !== null && meter.resetsAt <= nowMillis) return 0;
  return meter.usedPercent;
}

export interface SwitchCandidate {
  readonly number: number;
  readonly email: string;
  readonly active: boolean;
  readonly fiveHour: UsageMeter | null;
  readonly weekly: UsageMeter | null;
}

/**
 * Which claude-swap account to move to, or null to stay.
 *
 * Each account may have its own 5h ceiling (`thresholds`, keyed by email);
 * accounts without one run until the meter is full. The active account is left
 * once it reaches its ceiling or its weekly allowance is gone, for whichever
 * other account has the most room left under its own ceiling.
 */
export function chooseClaudeSwitch(
  accounts: ReadonlyArray<SwitchCandidate>,
  thresholds: Readonly<Record<string, number>>,
  nowMillis: number,
): number | null {
  const ceiling = (account: SwitchCandidate) => thresholds[account.email] ?? 100;
  const room = (account: SwitchCandidate) =>
    currentPercent(account.weekly, nowMillis) >= 100
      ? 0
      : ceiling(account) - currentPercent(account.fiveHour, nowMillis);
  const active = accounts.find((account) => account.active);
  if (active === undefined || room(active) > 0) return null;
  const best = accounts
    .filter((account) => !account.active && room(account) > 0)
    .toSorted((left, right) => room(right) - room(left))[0];
  return best?.number ?? null;
}
