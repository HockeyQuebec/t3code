import { ScheduledTurnId, ThreadId, type ScheduledTurn } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ScheduledTurnCard } from "./ScheduledTurnCard";

const NOW = Date.parse("2024-01-01T12:00:00.000Z");

function makeTurn(overrides: Partial<ScheduledTurn> = {}): ScheduledTurn {
  return {
    id: ScheduledTurnId.make("sched-1"),
    threadId: ThreadId.make("thread-1"),
    prompt: "tidy the onboarding copy",
    origin: "user",
    runAt: "2024-01-01T15:12:00.000Z",
    status: "pending",
    createdAt: "2024-01-01T11:00:00.000Z",
    ...overrides,
  };
}

describe("ScheduledTurnCard", () => {
  it("shows the prompt and a countdown, with both pending actions", () => {
    const markup = renderToStaticMarkup(
      <ScheduledTurnCard
        turn={makeTurn()}
        title="Waiting for the usage limit to reset"
        reason="Usage limit reached"
        nowMillis={NOW}
        onRunNow={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(markup).toContain("tidy the onboarding copy");
    expect(markup).toContain("in 3h 12m");
    expect(markup).toContain("Run now");
    expect(markup).toContain("Cancel");
  });

  it("hides the pending actions once the schedule has been dispatched", () => {
    const markup = renderToStaticMarkup(
      <ScheduledTurnCard
        turn={makeTurn({ status: "dispatched" })}
        title="Waiting for the usage limit to reset"
        reason="Usage limit reached"
        nowMillis={NOW}
        onRunNow={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(markup).toContain("This already started.");
    expect(markup).not.toContain("Run now");
    expect(markup).not.toContain(">Cancel<");
  });

  it("offers recovery for a cancelled schedule and says the failure for a failed one", () => {
    const cancelled = renderToStaticMarkup(
      <ScheduledTurnCard
        turn={makeTurn({ status: "cancelled" })}
        title="Nothing was sent"
        reason="This thread was created for a prompt that was queued to send later."
        nowMillis={NOW}
        onSendNow={vi.fn()}
        onReschedule={vi.fn()}
      />,
    );
    expect(cancelled).toContain("Send it now");
    expect(cancelled).toContain("Reschedule");
    expect(cancelled).toContain("cancelled before it ran");

    const failed = renderToStaticMarkup(
      <ScheduledTurnCard
        turn={makeTurn({ status: "failed", error: "provider offline" })}
        title="Nothing was sent"
        reason="This thread was created for a prompt that was queued to send later."
        nowMillis={NOW}
        onSendNow={vi.fn()}
      />,
    );
    expect(failed).toContain("provider offline");
    expect(failed).toContain("Send it now");
  });

  it("says so when the schedule it refers to is gone, and offers nothing", () => {
    const markup = renderToStaticMarkup(
      <ScheduledTurnCard
        turn={null}
        title="Waiting for the usage limit to reset"
        reason="Usage limit reached"
        fallbackRunAt="2024-01-01T15:12:00.000Z"
        nowMillis={NOW}
        onRunNow={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(markup).toContain("no longer listed");
    expect(markup).not.toContain("Run now");
  });
});
