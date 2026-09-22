import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { ScheduledTurnId, ThreadId, type ScheduledTurn } from "@t3tools/contracts";

const testState = vi.hoisted(() => ({
  useScheduledTurns: vi.fn(),
  useCancelScheduledTurn: vi.fn(),
}));

vi.mock("../../lib/scheduledTurnsState", () => ({
  useScheduledTurns: testState.useScheduledTurns,
  useCancelScheduledTurn: testState.useCancelScheduledTurn,
}));

import {
  formatCountdown,
  ScheduledWorkSettings,
  sortScheduledTurns,
} from "./ScheduledWorkSettings";

const readAt = DateTime.makeUnsafe("2024-01-01T12:00:00.000Z");

function makeTurn(id: string, overrides: Partial<ScheduledTurn> = {}): ScheduledTurn {
  return {
    id: ScheduledTurnId.make(id),
    threadId: ThreadId.make("thread-1"),
    prompt: "Run the nightly cleanup",
    origin: "user",
    runAt: new Date(Date.now() + 3 * 60 * 60_000 + 12 * 60_000).toISOString(),
    status: "pending",
    createdAt: "2024-01-01T10:00:00.000Z",
    ...overrides,
  };
}

function mockList(scheduled: ReadonlyArray<ScheduledTurn>) {
  testState.useScheduledTurns.mockReturnValue({
    data: { readAt, scheduled },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  });
  testState.useCancelScheduledTurn.mockReturnValue(vi.fn(async () => true));
}

describe("ScheduledWorkSettings", () => {
  it("explains the empty state", () => {
    mockList([]);
    const markup = renderToStaticMarkup(<ScheduledWorkSettings />);
    expect(markup).toContain("Nothing queued");
    expect(markup).toContain("as long as the server is running");
  });

  it("shows a countdown and a cancel button for a pending turn", () => {
    mockList([makeTurn("sched-1")]);
    const markup = renderToStaticMarkup(<ScheduledWorkSettings />);
    expect(markup).toContain("Run the nightly cleanup");
    expect(markup).toContain("in 3h 1");
    expect(markup).toContain("Cancel");
    expect(markup).toContain("Queued");
  });

  it("says why a failed turn could not run", () => {
    mockList([
      makeTurn("sched-2", {
        status: "failed",
        error: "Worktree was deleted before the turn started",
      }),
    ]);
    const markup = renderToStaticMarkup(<ScheduledWorkSettings />);
    expect(markup).toContain("Worktree was deleted before the turn started");
    expect(markup).toContain("Failed");
    expect(markup).not.toContain("Cancel");
  });

  it("sorts pending soonest-first, then the rest newest-first", () => {
    const soon = makeTurn("soon", { runAt: "2024-06-01T10:00:00.000Z" });
    const later = makeTurn("later", { runAt: "2024-06-01T18:00:00.000Z" });
    const oldDone = makeTurn("old", {
      status: "dispatched",
      createdAt: "2024-05-01T00:00:00.000Z",
    });
    const newDone = makeTurn("new", {
      status: "cancelled",
      createdAt: "2024-05-20T00:00:00.000Z",
    });

    expect(sortScheduledTurns([oldDone, later, newDone, soon]).map((turn) => turn.id)).toEqual([
      "soon",
      "later",
      "new",
      "old",
    ]);
  });

  it("formats countdowns in minutes and hours", () => {
    const now = Date.parse("2024-01-01T12:00:00.000Z");
    expect(formatCountdown(now + 12 * 60_000, now)).toBe("in 12m");
    expect(formatCountdown(now + (3 * 60 + 12) * 60_000, now)).toBe("in 3h 12m");
    expect(formatCountdown(now - 60_000, now)).toBe("due now");
  });

  it("says when a queued turn was written by a usage limit rather than by the user", () => {
    mockList([makeTurn("sched-limit", { origin: "usage-limit" })]);
    const markup = renderToStaticMarkup(<ScheduledWorkSettings />);
    expect(markup).toContain("Limit resume");
    expect(markup).toContain("Queued automatically after a usage limit");
  });

  it("tells an automatic retry apart from a usage limit resume", () => {
    mockList([makeTurn("sched-retry", { origin: "auto-retry" })]);
    const markup = renderToStaticMarkup(<ScheduledWorkSettings />);
    expect(markup).toContain("Auto retry");
    expect(markup).toContain("Queued automatically after an unexpected stop");
    expect(markup).not.toContain("Limit resume");
  });

  it("labels nothing for an origin it has never heard of", () => {
    mockList([makeTurn("sched-future", { origin: "invented-later" as ScheduledTurn["origin"] })]);
    const markup = renderToStaticMarkup(<ScheduledWorkSettings />);
    expect(markup).toContain("Run the nightly cleanup");
    expect(markup).not.toContain("Auto retry");
    expect(markup).not.toContain("Limit resume");
  });
});
