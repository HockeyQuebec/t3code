import type { AgentLimitLevel, AgentLimitWindow, ProviderLimitSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/**
 * Turning a limits snapshot into the handful of strings a status indicator
 * shows. Kept out of the components so the wording can be tested without
 * rendering anything.
 */

export interface LimitDisplay {
  readonly instanceId: string;
  readonly label: string;
  readonly usedPercent: number | null;
  readonly level: AgentLimitLevel;
  /** "3h 12m", or null when the provider never said when it refills. */
  readonly resetsIn: string | null;
  /** "5h window" / "weekly" — what the percentage is a percentage *of*. */
  readonly windowLabel: string | null;
  readonly stale: boolean;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A countdown that drops precision as it grows: seconds matter at the end of a
 * window and are noise at the start of one.
 */
export function formatCountdown(seconds: number): string {
  if (seconds <= 0) {
    return "now";
  }
  if (seconds < MINUTE) {
    return `${Math.ceil(seconds)}s`;
  }
  if (seconds < HOUR) {
    return `${Math.floor(seconds / MINUTE)}m`;
  }
  if (seconds < DAY) {
    const hours = Math.floor(seconds / HOUR);
    const minutes = Math.floor((seconds % HOUR) / MINUTE);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(seconds / DAY);
  const hours = Math.floor((seconds % DAY) / HOUR);
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/**
 * What the percentage is measured against.
 *
 * Providers meter in different blocks, and writing "5h" over a Codex weekly
 * number would be a lie, so the window's own length names it.
 */
export function windowLabel(minutes: number | null): string | null {
  if (minutes === null || minutes <= 0) {
    return null;
  }
  if (minutes >= (6 * DAY) / MINUTE) {
    return "weekly";
  }
  if (minutes >= DAY / MINUTE) {
    return `${Math.round(minutes / (DAY / MINUTE))}d window`;
  }
  if (minutes >= 60) {
    return `${Math.round(minutes / 60)}h window`;
  }
  return `${Math.round(minutes)}m window`;
}

function windowFrom(option: Option.Option<AgentLimitWindow>): AgentLimitWindow | null {
  return Option.getOrNull(option);
}

export function toLimitDisplay(snapshot: ProviderLimitSnapshot, nowMillis: number): LimitDisplay {
  const binding = windowFrom(snapshot.binding);
  const resetsAt = binding === null ? null : Option.getOrNull(binding.resetsAt);
  const resetsAtMillis = resetsAt === null ? null : DateTime.toEpochMillis(resetsAt);
  const secondsToReset = resetsAtMillis === null ? null : (resetsAtMillis - nowMillis) / 1000;

  return {
    instanceId: snapshot.instanceId,
    label: snapshot.label,
    usedPercent: binding?.usedPercent ?? null,
    level: snapshot.level,
    resetsIn: secondsToReset === null ? null : formatCountdown(secondsToReset),
    windowLabel: binding === null ? null : windowLabel(Option.getOrNull(binding.windowMinutes)),
    // Past its own reset, a reading describes a window that has already
    // refilled, so the number on screen is history rather than headroom.
    stale: secondsToReset !== null && secondsToReset <= 0,
  };
}

/**
 * Which providers to surface, worst headroom first — the one about to run out
 * is the one worth looking at.
 */
export function rankLimits(
  providers: ReadonlyArray<ProviderLimitSnapshot>,
  nowMillis: number,
): ReadonlyArray<LimitDisplay> {
  return providers
    .map((provider) => toLimitDisplay(provider, nowMillis))
    .sort((left, right) => (right.usedPercent ?? -1) - (left.usedPercent ?? -1));
}

export interface LimitWindowDisplay {
  /** "5h" / "7d": the window's own length, short enough for a sidebar. */
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsIn: string | null;
  readonly stale: boolean;
}

export interface LimitAccountDisplay {
  readonly instanceId: string;
  readonly label: string;
  readonly detail: string | null;
  readonly cswapAccount: number | null;
  readonly active: boolean;
  readonly level: AgentLimitLevel;
  readonly windows: ReadonlyArray<LimitWindowDisplay>;
}

function shortWindowLabel(minutes: number | null, fallback: string): string {
  if (minutes === null || minutes <= 0) {
    return fallback;
  }
  if (minutes >= DAY / MINUTE) {
    return `${Math.round(minutes / (DAY / MINUTE))}d`;
  }
  return minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes)}m`;
}

function toWindowDisplay(
  window: AgentLimitWindow,
  fallbackLabel: string,
  nowMillis: number,
): LimitWindowDisplay {
  const resetsAt = Option.getOrNull(window.resetsAt);
  const seconds = resetsAt === null ? null : (DateTime.toEpochMillis(resetsAt) - nowMillis) / 1000;
  return {
    label: shortWindowLabel(Option.getOrNull(window.windowMinutes), fallbackLabel),
    usedPercent: window.usedPercent,
    resetsIn: seconds === null ? null : formatCountdown(seconds),
    stale: seconds !== null && seconds <= 0,
  };
}

/**
 * Every account with both of its windows, in a stable order so rows do not
 * jump around as usage changes: Claude accounts, then everyone else.
 */
export function toLimitAccounts(
  providers: ReadonlyArray<ProviderLimitSnapshot>,
  nowMillis: number,
): ReadonlyArray<LimitAccountDisplay> {
  const driverOrder = (driver: string) =>
    driver === "claudeAgent" ? 0 : driver === "codex" ? 1 : 2;
  return providers
    .toSorted(
      (left, right) =>
        driverOrder(left.driver) - driverOrder(right.driver) ||
        left.instanceId.localeCompare(right.instanceId),
    )
    .map((provider) => ({
      instanceId: provider.instanceId,
      label: provider.label,
      detail: provider.detail ?? null,
      cswapAccount: provider.cswapAccount ?? null,
      active: provider.active === true,
      level: provider.level,
      windows: [
        Option.map(provider.short, (window) => toWindowDisplay(window, "5h", nowMillis)),
        Option.map(provider.long, (window) => toWindowDisplay(window, "7d", nowMillis)),
      ].flatMap((window) => (Option.isSome(window) ? [window.value] : [])),
    }));
}

export function formatUsd(amount: number): string {
  if (amount === 0) {
    return "$0.00";
  }
  if (amount < 0.01) {
    return "<$0.01";
  }
  return `$${amount.toFixed(2)}`;
}

/**
 * A total that is partly modelled is written with a `~`, so an estimate never
 * reads as something the provider actually charged.
 */
export function formatSpend(reportedUsd: number, estimatedUsd: number): string {
  const total = reportedUsd + estimatedUsd;
  return estimatedUsd > 0 ? `~${formatUsd(total)}` : formatUsd(total);
}
