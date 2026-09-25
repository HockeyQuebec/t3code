import {
  EventId,
  ScheduledTurnId,
  ThreadId,
  type OrchestrationThreadActivity,
  type ScheduledTurn,
} from "@t3tools/contracts";
import { TASK_MARKER } from "@t3tools/shared/usageLimitResume";
import { describe, expect, it } from "vite-plus/test";

import {
  collectScheduledActivities,
  describeScheduledTurnState,
  formatCountdown,
  resolveResumeCandidate,
  resolveScheduledActivityCopy,
  resolveScheduledTurnActions,
  scheduledTurnsForThread,
} from "./threadRecovery";

function makeActivity(overrides: Partial<OrchestrationThreadActivity> = {}) {
  return {
    id: EventId.make("activity-1"),
    tone: "info",
    kind: "usage-limit.resume-scheduled",
    summary: "Usage limit reached — this work is queued to resume",
    payload: { runAt: "2024-01-01T13:00:00.000Z", scheduledTurnId: "sched-1" },
    turnId: null,
    createdAt: "2024-01-01T12:00:00.000Z",
    ...overrides,
  } as OrchestrationThreadActivity;
}

function makeTurn(overrides: Partial<ScheduledTurn> = {}): ScheduledTurn {
  return {
    id: ScheduledTurnId.make("sched-1"),
    threadId: ThreadId.make("thread-1"),
    prompt: "tidy the onboarding copy",
    origin: "user",
    runAt: "2024-01-01T13:00:00.000Z",
    status: "pending",
    createdAt: "2024-01-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("formatCountdown", () => {
  it("counts down in the coarsest unit that still says something", () => {
    const now = Date.parse("2024-01-01T12:00:00.000Z");
    expect(formatCountdown(now - 1_000, now)).toBe("due now");
    expect(formatCountdown(now + 90_000, now)).toBe("in 1m");
    expect(formatCountdown(now + 3 * 60 * 60_000 + 12 * 60_000, now)).toBe("in 3h 12m");
    expect(formatCountdown(now + 26 * 60 * 60_000, now)).toBe("in 1d 2h");
  });
});

describe("resolveResumeCandidate", () => {
  const base = {
    isWorking: false,
    lastUserMessageText: "port the parser to the new AST",
    worktreePath: "/tmp/worktree",
    providerDriverKind: "claude",
  };

  it("offers nothing while a turn is running", () => {
    expect(
      resolveResumeCandidate({ ...base, isWorking: true, latestTurn: { state: "running" } }),
    ).toBeNull();
  });

  it("offers nothing for a turn that finished", () => {
    expect(resolveResumeCandidate({ ...base, latestTurn: { state: "completed" } })).toBeNull();
    expect(resolveResumeCandidate({ ...base, latestTurn: null })).toBeNull();
  });

  it("resumes a failed turn as a conversation", () => {
    const candidate = resolveResumeCandidate({ ...base, latestTurn: { state: "error" } });
    expect(candidate?.kind).toBe("conversation");
    expect(candidate?.prompt).toContain("do not start over");
  });

  it("resumes a turn the user stopped", () => {
    const candidate = resolveResumeCandidate({ ...base, latestTurn: { state: "interrupted" } });
    expect(candidate).not.toBeNull();
  });

  it("never claims a usage limit it cannot know about", () => {
    for (const kind of ["claude", "harness"]) {
      const candidate = resolveResumeCandidate({
        ...base,
        providerDriverKind: kind,
        latestTurn: { state: "error" },
      });
      expect(candidate?.prompt).not.toContain("usage limit");
      expect(candidate?.prompt).not.toContain("has since reset");
    }
  });

  it("re-states the task verbatim for a harness thread", () => {
    const candidate = resolveResumeCandidate({
      ...base,
      providerDriverKind: "harness",
      latestTurn: { state: "error" },
    });
    expect(candidate?.kind).toBe("batch");
    expect(candidate?.prompt).toContain("port the parser to the new AST");
    expect(candidate?.prompt).toContain("/tmp/worktree");
  });

  it("does not stack preambles when resuming a resume", () => {
    const candidate = resolveResumeCandidate({
      ...base,
      providerDriverKind: "harness",
      lastUserMessageText: `A previous run stopped.\n\n${TASK_MARKER}\n\nport the parser to the new AST`,
      latestTurn: { state: "error" },
    });
    expect(candidate?.prompt).toContain("port the parser to the new AST");
    expect(candidate?.prompt?.split(TASK_MARKER)).toHaveLength(2);
  });

  it("gives up on a harness thread with no task text to re-send", () => {
    expect(
      resolveResumeCandidate({
        ...base,
        providerDriverKind: "harness",
        lastUserMessageText: null,
        latestTurn: { state: "error" },
      }),
    ).toBeNull();
  });
});

describe("collectScheduledActivities", () => {
  it("finds any activity that names a schedule, whatever its kind", () => {
    const references = collectScheduledActivities([
      makeActivity({ kind: "tool.started", payload: { name: "bash" } }),
      makeActivity(),
      makeActivity({
        id: EventId.make("activity-2"),
        kind: "turn.auto-retry-scheduled",
        summary: "The run stopped unexpectedly — retrying shortly",
        payload: { runAt: "2024-01-01T14:00:00.000Z", scheduledTurnId: "sched-2" },
      }),
      makeActivity({
        id: EventId.make("activity-3"),
        kind: "something.invented.later",
        payload: { scheduledTurnId: "sched-3" },
      }),
    ]);
    expect(references.map((reference) => reference.scheduledTurnId)).toEqual([
      "sched-1",
      "sched-2",
      "sched-3",
    ]);
    expect(references[2]?.runAt).toBeNull();
  });

  it("keeps the latest announcement of each schedule", () => {
    const references = collectScheduledActivities([
      makeActivity(),
      makeActivity({ id: EventId.make("activity-9"), summary: "re-announced" }),
    ]);
    expect(references).toHaveLength(1);
    expect(references[0]?.summary).toBe("re-announced");
  });
});

describe("resolveScheduledActivityCopy", () => {
  it("names a usage limit", () => {
    const copy = resolveScheduledActivityCopy({ kind: "usage-limit.resume-scheduled" });
    expect(copy.title).toContain("usage limit");
    expect(copy.reason).toContain("Usage limit reached");
  });

  it("names an automatic retry", () => {
    const copy = resolveScheduledActivityCopy({ kind: "turn.auto-retry-scheduled" });
    expect(copy.title).toBe("Retrying after an unexpected stop");
    expect(copy.reason).toContain("unrelated to the task");
  });

  it("reads the origin when the kind says nothing", () => {
    expect(resolveScheduledActivityCopy({ kind: "queued", origin: "auto-retry" }).title).toBe(
      "Retrying after an unexpected stop",
    );
  });

  it("falls back to the activity's own summary for a kind it has never seen", () => {
    const copy = resolveScheduledActivityCopy({
      kind: "some.future.kind",
      summary: "Queued for the small hours",
    });
    expect(copy.title).toBe("Queued to run later");
    expect(copy.reason).toBe("Queued for the small hours");
  });

  it("still says something when there is no summary either", () => {
    expect(resolveScheduledActivityCopy({}).reason.length).toBeGreaterThan(0);
  });
});

describe("resolveScheduledTurnActions", () => {
  it("offers running early or calling off only while pending", () => {
    expect(resolveScheduledTurnActions("pending")).toEqual(["run-now", "edit", "cancel"]);
  });

  it("offers recovery for a schedule that never ran", () => {
    expect(resolveScheduledTurnActions("cancelled")).toEqual(["send-now", "reschedule"]);
    expect(resolveScheduledTurnActions("failed")).toEqual(["send-now", "reschedule"]);
  });

  it("offers nothing for a schedule that already fired or cannot be found", () => {
    expect(resolveScheduledTurnActions("dispatched")).toEqual([]);
    expect(resolveScheduledTurnActions(null)).toEqual([]);
    expect(resolveScheduledTurnActions("invented-later")).toEqual([]);
  });
});

describe("describeScheduledTurnState", () => {
  it("says nothing while the schedule is still pending", () => {
    expect(describeScheduledTurnState(makeTurn())).toBeNull();
  });

  it("explains a schedule this client can no longer find", () => {
    expect(describeScheduledTurnState(null)).toContain("no longer listed");
  });

  it("quotes the failure", () => {
    expect(
      describeScheduledTurnState(makeTurn({ status: "failed", error: "provider offline" })),
    ).toContain("provider offline");
  });

  it("names a status it does not recognise rather than going blank", () => {
    expect(
      describeScheduledTurnState(makeTurn({ status: "abandoned" as ScheduledTurn["status"] })),
    ).toContain("abandoned");
  });
});

describe("scheduledTurnsForThread", () => {
  it("leads with the soonest pending row and keeps the finished ones", () => {
    const turns = [
      makeTurn({ id: ScheduledTurnId.make("other"), threadId: ThreadId.make("thread-2") }),
      makeTurn({
        id: ScheduledTurnId.make("done"),
        status: "cancelled",
        createdAt: "2024-01-01T11:00:00.000Z",
      }),
      makeTurn({ id: ScheduledTurnId.make("later"), runAt: "2024-01-01T18:00:00.000Z" }),
      makeTurn({ id: ScheduledTurnId.make("sooner"), runAt: "2024-01-01T13:00:00.000Z" }),
    ];
    expect(scheduledTurnsForThread(turns, "thread-1").map((turn) => turn.id)).toEqual([
      "sooner",
      "later",
      "done",
    ]);
  });
});
