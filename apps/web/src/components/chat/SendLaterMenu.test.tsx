import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildSendLaterOptions, schedulePreset, SendLaterMenu } from "./SendLaterMenu";

describe("SendLaterMenu", () => {
  it("renders nothing when there is nothing to schedule", () => {
    const markup = renderToStaticMarkup(<SendLaterMenu disabled={false} onSchedule={null} />);
    expect(markup).toBe("");
  });

  it("renders a trigger when scheduling is possible", () => {
    const markup = renderToStaticMarkup(
      <SendLaterMenu disabled={false} onSchedule={() => undefined} />,
    );
    expect(markup).toContain("Send later");
  });

  it("offers the four presets with their resolved times", () => {
    const options = buildSendLaterOptions(Date.parse("2024-01-01T12:00:00.000Z"));
    expect(options.map((option) => option.id)).toEqual(["1h", "3h", "tonight", "tomorrow"]);
    expect(options.map((option) => option.label)).toEqual([
      "In 1 hour",
      "In 3 hours",
      "Tonight (10pm)",
      "Tomorrow (9am)",
    ]);
    for (const option of options) {
      expect(option.timeLabel.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(option.runAtIso))).toBe(false);
    }
  });

  it("schedules a preset at a future ISO instant", () => {
    const onSchedule = vi.fn();
    const now = Date.now();
    schedulePreset(onSchedule, "1h", now);

    expect(onSchedule).toHaveBeenCalledTimes(1);
    const runAtIso = onSchedule.mock.calls[0]?.[0] as string;
    expect(typeof runAtIso).toBe("string");
    expect(runAtIso).toBe(new Date(now + 60 * 60_000).toISOString());
    expect(Date.parse(runAtIso)).toBeGreaterThan(now);
  });
});
