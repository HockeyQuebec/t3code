import type {
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
  ScheduledTurn,
} from "@t3tools/contracts";
import {
  buildResumePrompt,
  extractOriginalTask,
  type ResumeKind,
} from "@t3tools/shared/usageLimitResume";
import { useEffect, useState } from "react";

/**
 * Reading a thread that stopped, and saying what can still be done about it.
 *
 * Three situations put a thread in front of someone with nothing to click: a
 * turn that died, a resume the server queued on their behalf, and a "send
 * later" whose schedule was called off before it ran. All three are recoverable
 * from what the client already knows, so the wording and the decisions live
 * here where they can be checked without rendering anything.
 */

/** A minute is the smallest unit shown, so a 30s tick never lags a label. */
const COUNTDOWN_TICK_MS = 30_000;

/**
 * A clock that only moves every 30 seconds.
 *
 * Countdowns are read in minutes, so a per-second timer would repaint every
 * card sixty times for each visible change.
 */
export function useCoarseNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function formatCountdown(runAtMillis: number, nowMillis: number): string {
  const deltaMs = runAtMillis - nowMillis;
  if (deltaMs <= 0) {
    return "due now";
  }
  const totalMinutes = Math.floor(deltaMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `in ${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `in ${hours}h ${minutes}m`;
  }
  return `in ${Math.max(minutes, 1)}m`;
}

export function formatScheduledAt(runAtMillis: number): string {
  return new Date(runAtMillis).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The driver kind the web uses to recognise an Agent Harness thread. */
export const HARNESS_DRIVER_KIND = "harness";

export interface ResumeCandidateInput {
  /** The thread's latest turn, or null when it has never run one. */
  readonly latestTurn: Pick<OrchestrationLatestTurn, "state"> | null;
  /** True while anything is in flight, which is when resuming is meaningless. */
  readonly isWorking: boolean;
  /** The last thing the user actually sent, which is what a batch run re-sends. */
  readonly lastUserMessageText: string | null;
  readonly worktreePath: string | null;
  /** The thread's provider driver kind, or null when it cannot be determined. */
  readonly providerDriverKind: string | null;
}

export interface ResumeCandidate {
  readonly kind: ResumeKind;
  readonly prompt: string;
}

/**
 * The prompt that would pick the interrupted work back up, or null when there
 * is nothing to resume.
 *
 * Only a turn that ended badly qualifies: a completed turn has nothing to carry
 * on from, and offering "Resume" there would read as an invitation to redo
 * finished work. A running turn is excluded for the same reason the button is
 * disabled — the work is already happening.
 *
 * `extractOriginalTask` unwraps a prompt that was itself a resume, so resuming
 * twice does not stack preambles.
 */
export function resolveResumeCandidate(input: ResumeCandidateInput): ResumeCandidate | null {
  if (input.isWorking) {
    return null;
  }
  const state = input.latestTurn?.state ?? null;
  if (state !== "error" && state !== "interrupted") {
    return null;
  }

  // A harness turn is one `agent-harness run` process with no session behind
  // it, so it can only be resumed by re-sending the task verbatim. Every other
  // provider keeps the conversation and only needs a nudge. When the driver is
  // unknown, `conversation` is the safer guess: it never re-states a task into
  // a thread that already contains it.
  const kind: ResumeKind =
    input.providerDriverKind === HARNESS_DRIVER_KIND ? "batch" : "conversation";
  const lastUserMessageText = input.lastUserMessageText?.trim() ?? "";
  const prompt = buildResumePrompt({
    kind,
    // Always the neutral wording, never the usage-limit wording. A turn that
    // stopped on a limit is resumed by the server on a schedule and shows a
    // card, not this button — so anything reaching here stopped for a reason
    // nobody has established, and `latestTurn` carries no error text to
    // establish it with. Claiming "the limit has since reset" would be a
    // sentence the client cannot know is true.
    reason: "transient",
    originalTask:
      lastUserMessageText.length === 0 ? null : extractOriginalTask(lastUserMessageText),
    workspace: input.worktreePath,
    // The web never sees which workflow node a harness run died on; that only
    // reaches the server's event stream.
    failedStep: null,
  });
  return prompt === null ? null : { kind, prompt };
}

/**
 * A thread activity that points at a scheduled turn.
 *
 * Matched on the payload rather than on the activity's `kind`, deliberately:
 * the server has more than one reason to queue work on a thread's behalf, and a
 * kind this build has never heard of still describes a schedule the user should
 * be able to run or call off.
 */
export interface ScheduledActivityReference {
  readonly activityId: string;
  readonly scheduledTurnId: string;
  readonly kind: string;
  readonly summary: string;
  /** The activity's own copy of the due time, kept so a card can still say when. */
  readonly runAt: string | null;
  readonly createdAt: string;
}

function readPayloadString(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Every schedule a thread's activities refer to, oldest first and one per
 * schedule — a thread that queued, cancelled and re-queued shows the latest
 * account of each, not one card per announcement.
 */
export function collectScheduledActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<ScheduledActivityReference> {
  const byScheduledTurnId = new Map<string, ScheduledActivityReference>();
  for (const activity of activities) {
    const scheduledTurnId = readPayloadString(activity.payload, "scheduledTurnId");
    if (scheduledTurnId === null) {
      continue;
    }
    byScheduledTurnId.set(scheduledTurnId, {
      activityId: activity.id,
      scheduledTurnId,
      kind: activity.kind,
      summary: activity.summary,
      runAt: readPayloadString(activity.payload, "runAt"),
      createdAt: activity.createdAt,
    });
  }
  return [...byScheduledTurnId.values()];
}

export interface ScheduledActivityCopy {
  readonly title: string;
  readonly reason: string;
}

/**
 * What to call a schedule nobody asked for.
 *
 * Driven off the activity kind and the schedule's origin together, with the
 * activity's own summary as the fallback, so a kind or origin added after this
 * build still produces a card that says something true rather than an empty
 * one.
 */
export function resolveScheduledActivityCopy(input: {
  readonly kind?: string | null;
  readonly origin?: string | null;
  readonly summary?: string | null;
}): ScheduledActivityCopy {
  const signal = `${input.kind ?? ""} ${input.origin ?? ""}`;
  if (signal.includes("usage-limit")) {
    return {
      title: "Waiting for the usage limit to reset",
      reason: "Usage limit reached — this work is queued to resume once the window reopens.",
    };
  }
  if (signal.includes("auto-retry")) {
    return {
      title: "Retrying after an unexpected stop",
      reason: "This run stopped for a reason unrelated to the task, so it is queued to try again.",
    };
  }
  const summary = input.summary?.trim() ?? "";
  return {
    title: "Queued to run later",
    reason: summary.length > 0 ? summary : "This work is queued to run later.",
  };
}

export type ScheduledTurnAction = "run-now" | "cancel" | "send-now" | "reschedule" | "edit";

/**
 * What a schedule in this state can still be asked to do.
 *
 * A schedule that already fired, or that this client can no longer find, gets
 * nothing: a button that provably does nothing is worse than no button.
 */
export function resolveScheduledTurnActions(
  status: string | null,
): ReadonlyArray<ScheduledTurnAction> {
  if (status === "pending") {
    return ["run-now", "edit", "cancel"];
  }
  if (status === "cancelled" || status === "failed") {
    return ["send-now", "reschedule"];
  }
  return [];
}

/** A sentence for a schedule that is past acting on, or null while it is pending. */
export function describeScheduledTurnState(turn: ScheduledTurn | null): string | null {
  if (turn === null) {
    return "This schedule is no longer listed — it may have already run.";
  }
  switch (turn.status) {
    case "pending":
      return null;
    case "dispatched":
      return "This already started.";
    case "cancelled":
      return "This was cancelled before it ran.";
    case "failed":
      return turn.error ? `This could not start: ${turn.error}` : "This could not start.";
    default:
      // An unrecognised status is still a status: say what it is rather than
      // pretending the schedule is actionable.
      return `This schedule is ${String(turn.status)}.`;
  }
}

export function findScheduledTurnById(
  turns: ReadonlyArray<ScheduledTurn>,
  id: string,
): ScheduledTurn | null {
  return turns.find((turn) => turn.id === id) ?? null;
}

/**
 * The schedules that belong to one thread, soonest-pending first.
 *
 * A "send later" that was cancelled leaves a titled thread with nothing in it,
 * and that row is the only record of what was supposed to happen — so anything
 * but `pending` is kept too, newest first behind the pending ones.
 */
export function scheduledTurnsForThread(
  turns: ReadonlyArray<ScheduledTurn>,
  threadId: string,
): ReadonlyArray<ScheduledTurn> {
  const mine = turns.filter((turn) => turn.threadId === threadId);
  const pending = mine
    .filter((turn) => turn.status === "pending")
    .toSorted((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt));
  const rest = mine
    .filter((turn) => turn.status !== "pending")
    .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return [...pending, ...rest];
}
