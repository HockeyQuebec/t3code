import { ScheduledTurnId, ThreadId, type ScheduledTurn } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useScheduledTurns: vi.fn(),
  useCancelScheduledTurn: vi.fn(),
  useScheduleTurn: vi.fn(),
}));

// Only the three RPC hooks are stubbed; the reschedule picker reads its presets
// from the same module and must keep the real ones.
vi.mock("~/lib/scheduledTurnsState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/scheduledTurnsState")>()),
  useScheduledTurns: testState.useScheduledTurns,
  useCancelScheduledTurn: testState.useCancelScheduledTurn,
  useScheduleTurn: testState.useScheduleTurn,
}));

import { TIMELINE_EMPTY_PLACEHOLDER_TEXT } from "./MessagesTimeline.logic";
import { ScheduledThreadEmptyState } from "./ScheduledThreadEmptyState";

const readAt = DateTime.makeUnsafe("2024-01-01T12:00:00.000Z");
const THREAD_ID = ThreadId.make("thread-1");

function mockSchedule(scheduled: ReadonlyArray<ScheduledTurn>) {
  testState.useScheduledTurns.mockReturnValue({
    data: { readAt, scheduled },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  });
  testState.useCancelScheduledTurn.mockReturnValue(vi.fn(async () => true));
  testState.useScheduleTurn.mockReturnValue(vi.fn());
}

function makeTurn(overrides: Partial<ScheduledTurn> = {}): ScheduledTurn {
  return {
    id: ScheduledTurnId.make("sched-1"),
    threadId: THREAD_ID,
    prompt: "tidy the onboarding copy",
    origin: "user",
    runAt: new Date(Date.now() + 3 * 60 * 60_000 + 12 * 60_000).toISOString(),
    status: "pending",
    createdAt: "2024-01-01T11:00:00.000Z",
    ...overrides,
  };
}

function render() {
  return renderToStaticMarkup(
    <ScheduledThreadEmptyState threadId={THREAD_ID} onSendPrompt={vi.fn()} />,
  );
}

describe("ScheduledThreadEmptyState", () => {
  it("falls back to the generic placeholder when nothing was ever scheduled", () => {
    mockSchedule([]);
    expect(render()).toContain(TIMELINE_EMPTY_PLACEHOLDER_TEXT);
  });

  it("ignores schedules that belong to another thread", () => {
    mockSchedule([makeTurn({ threadId: ThreadId.make("thread-2") })]);
    expect(render()).toContain(TIMELINE_EMPTY_PLACEHOLDER_TEXT);
  });

  it("shows the queued prompt with a countdown while it is pending", () => {
    mockSchedule([makeTurn()]);
    const markup = render();
    expect(markup).toContain("tidy the onboarding copy");
    expect(markup).toContain("in 3h 12m");
    expect(markup).toContain("Run now");
    expect(markup).toContain("Cancel");
  });

  it("offers the cancelled prompt back, with a way to reschedule it", () => {
    mockSchedule([makeTurn({ status: "cancelled" })]);
    const markup = render();
    expect(markup).toContain("Nothing was sent");
    expect(markup).toContain("tidy the onboarding copy");
    expect(markup).toContain("cancelled before it ran");
    expect(markup).toContain("Send it now");
    expect(markup).toContain("Reschedule");
    expect(markup).not.toContain("Run now");
  });

  it("says why a failed schedule never ran", () => {
    mockSchedule([makeTurn({ status: "failed", error: "the provider was not configured" })]);
    const markup = render();
    expect(markup).toContain("the provider was not configured");
    expect(markup).toContain("Send it now");
  });
});
