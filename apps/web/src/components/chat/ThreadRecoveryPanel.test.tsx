import {
  EventId,
  ScheduledTurnId,
  ThreadId,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type ScheduledTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useScheduledTurns: vi.fn(),
  useCancelScheduledTurn: vi.fn(),
  useScheduleTurn: vi.fn(),
  useUpdateScheduledTurn: vi.fn(),
}));

vi.mock("~/lib/agentLimitsState", () => ({
  useAgentLimits: () => ({ data: null }),
}));

vi.mock("~/lib/scheduledTurnsState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/scheduledTurnsState")>()),
  useScheduledTurns: testState.useScheduledTurns,
  useCancelScheduledTurn: testState.useCancelScheduledTurn,
  useScheduleTurn: testState.useScheduleTurn,
  useUpdateScheduledTurn: testState.useUpdateScheduledTurn,
}));

import { ThreadRecoveryPanel } from "./ThreadRecoveryPanel";

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
  testState.useUpdateScheduledTurn.mockReturnValue(vi.fn(async () => true));
}

function makeTurn(overrides: Partial<ScheduledTurn> = {}): ScheduledTurn {
  return {
    id: ScheduledTurnId.make("sched-1"),
    threadId: THREAD_ID,
    prompt: "carry on with the migration",
    origin: "usage-limit",
    // Relative to the real clock: the cards count down against `Date.now()`.
    runAt: new Date(Date.now() + 3 * 60 * 60_000 + 12 * 60_000).toISOString(),
    status: "pending",
    createdAt: "2024-01-01T11:00:00.000Z",
    ...overrides,
  };
}

function makeActivity(overrides: Partial<OrchestrationThreadActivity> = {}) {
  return {
    id: EventId.make("activity-1"),
    tone: "info",
    kind: "usage-limit.resume-scheduled",
    summary: "Usage limit reached — this work is queued to resume",
    payload: { runAt: "2024-01-01T15:12:00.000Z", scheduledTurnId: "sched-1" },
    turnId: null,
    createdAt: "2024-01-01T12:00:00.000Z",
    ...overrides,
  } as OrchestrationThreadActivity;
}

function makeLatestTurn(state: OrchestrationLatestTurn["state"]): OrchestrationLatestTurn {
  return {
    turnId: EventId.make("turn-1") as unknown as OrchestrationLatestTurn["turnId"],
    state,
    requestedAt: "2024-01-01T11:00:00.000Z",
    startedAt: "2024-01-01T11:00:01.000Z",
    completedAt: "2024-01-01T11:30:00.000Z",
    assistantMessageId: null,
  };
}

function render(props: Partial<Parameters<typeof ThreadRecoveryPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <ThreadRecoveryPanel
      threadId={THREAD_ID}
      activities={[]}
      latestTurn={null}
      isWorking={false}
      lastUserMessageText="migrate the parser"
      worktreePath="/tmp/worktree"
      providerDriverKind="claude"
      onSendPrompt={vi.fn()}
      {...props}
    />,
  );
}

describe("ThreadRecoveryPanel", () => {
  it("renders nothing when there is nothing to recover", () => {
    mockSchedule([]);
    expect(render({ latestTurn: makeLatestTurn("completed") })).toBe("");
  });

  it("offers a resume on a turn that failed", () => {
    mockSchedule([]);
    const markup = render({ latestTurn: makeLatestTurn("error") });
    expect(markup).toContain("This turn did not finish");
    expect(markup).toContain("Resume");
    expect(markup).not.toContain('disabled=""');
  });

  it("offers a resume on a turn the user stopped, and disables it while busy", () => {
    mockSchedule([]);
    expect(render({ latestTurn: makeLatestTurn("interrupted") })).toContain("Resume");
    expect(render({ latestTurn: makeLatestTurn("interrupted"), isWorking: true })).toBe("");
  });

  it("turns a queued resume into a card with a countdown and both actions", () => {
    mockSchedule([makeTurn()]);
    const markup = render({ activities: [makeActivity()] });
    expect(markup).toContain("Waiting for the usage limit to reset");
    expect(markup).toContain("carry on with the migration");
    expect(markup).toContain("in 3h");
    expect(markup).toContain("Run now");
    expect(markup).toContain("Cancel");
  });

  it("words an automatic retry differently", () => {
    mockSchedule([makeTurn({ origin: "auto-retry" })]);
    const markup = render({
      activities: [
        makeActivity({
          kind: "turn.auto-retry-scheduled",
          summary: "The run stopped unexpectedly — retrying shortly",
        }),
      ],
    });
    expect(markup).toContain("Retrying after an unexpected stop");
    expect(markup).not.toContain("Waiting for the usage limit");
  });

  it("still renders a card for an activity kind it has never seen", () => {
    mockSchedule([makeTurn({ origin: "user" })]);
    const markup = render({
      activities: [makeActivity({ kind: "turn.invented-later", summary: "Queued for later" })],
    });
    expect(markup).toContain("Queued for later");
    expect(markup).toContain("Run now");
  });

  it("shows a composer-queued turn that no activity announced", () => {
    mockSchedule([makeTurn({ origin: "user" })]);
    const markup = render();
    expect(markup).toContain("Queued to run later");
    expect(markup).toContain("Edit message");
  });

  it("drops the card once the schedule has been dispatched", () => {
    mockSchedule([makeTurn({ status: "dispatched" })]);
    const markup = render({ activities: [makeActivity()] });
    expect(markup).not.toContain("Waiting for the usage limit");
    expect(markup).not.toContain("Run now");
  });
});
