import { describe, expect, it } from "vite-plus/test";

import {
  bindingWindow,
  EMPTY_LIMIT_STATE,
  limitLevel,
  mergeLimitState,
  nextResetEpoch,
  parseClaudeRateLimitInfo,
  parseCodexSessionLimits,
  parseCswapList,
  parseCursorAboutTier,
  parseRateLimitsBlock,
  parseResetEpochFromText,
  parseStatuslineLimits,
  secondsToReset,
  windowClosed,
} from "./agentLimits.ts";

const NOW = 1_760_000_000;

describe("parseStatuslineLimits", () => {
  it("reads both Claude windows and labels their lengths", () => {
    const state = parseStatuslineLimits({
      five_hour: { used_percentage: 62.5, resets_at: NOW + 3600 },
      seven_day: { used_percentage: 18, resets_at: NOW + 200_000 },
      observed_at: NOW - 30,
    });

    expect(state.source).toBe("statusline");
    expect(state.observedAt).toBe(NOW - 30);
    expect(state.short).toEqual({ usedPercent: 62.5, resetsAt: NOW + 3600, windowMinutes: 300 });
    expect(state.long).toEqual({
      usedPercent: 18,
      resetsAt: NOW + 200_000,
      windowMinutes: 7 * 24 * 60,
    });
  });

  it("stays unknown for junk rather than reporting a fabricated zero", () => {
    expect(parseStatuslineLimits(null).source).toBe("unknown");
    expect(parseStatuslineLimits({}).source).toBe("unknown");
    expect(parseStatuslineLimits({ five_hour: { resets_at: NOW } }).source).toBe("unknown");
  });
});

describe("parseRateLimitsBlock", () => {
  it("sorts windows by length instead of trusting primary/secondary", () => {
    const state = parseRateLimitsBlock(
      {
        primary: { used_percent: 4, window_minutes: 10_080, resets_at: NOW + 400_000 },
        secondary: { used_percent: 71, window_minutes: 300, resets_at: NOW + 900 },
      },
      "providerSession",
      NOW,
    );

    expect(state.short?.usedPercent).toBe(71);
    expect(state.short?.windowMinutes).toBe(300);
    expect(state.long?.usedPercent).toBe(4);
  });

  it("treats a weekly-only plan's window as the binding one", () => {
    const state = parseRateLimitsBlock({
      primary: { used_percent: 88, window_minutes: 10_080, resets_at: NOW + 100 },
    });

    expect(state.short).toBeNull();
    expect(bindingWindow(state)?.usedPercent).toBe(88);
    expect(secondsToReset(state, NOW)).toBe(100);
  });
});

describe("parseRateLimitsBlock camelCase", () => {
  // The Codex app-server camelCases these; the rollout files on disk do not.
  it("reads the app-server spelling", () => {
    const state = parseRateLimitsBlock({
      primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: NOW + 600 },
      secondary: { usedPercent: 9, windowDurationMins: 10_080, resetsAt: NOW + 90_000 },
    });

    expect(state.short).toEqual({ usedPercent: 40, resetsAt: NOW + 600, windowMinutes: 300 });
    expect(state.long?.usedPercent).toBe(9);
  });
});

describe("parseClaudeRateLimitInfo", () => {
  it("scales a fractional utilization into a percentage", () => {
    const state = parseClaudeRateLimitInfo(
      {
        rate_limit_info: {
          status: "allowed",
          rateLimitType: "five_hour",
          utilization: 0.62,
          resetsAt: NOW + 900,
        },
      },
      NOW,
    );

    expect(state.short?.usedPercent).toBeCloseTo(62, 5);
    expect(state.short?.resetsAt).toBe(NOW + 900);
    expect(state.long).toBeNull();
  });

  it("files every weekly bucket in the long window", () => {
    for (const kind of ["seven_day", "seven_day_opus", "seven_day_sonnet"]) {
      const state = parseClaudeRateLimitInfo({ rateLimitType: kind, utilization: 0.2 });
      expect(state.long?.windowMinutes).toBe(7 * 24 * 60);
      expect(state.short).toBeNull();
    }
  });

  it("says nothing when the event carries no utilization", () => {
    expect(parseClaudeRateLimitInfo({ status: "allowed" })).toEqual(EMPTY_LIMIT_STATE);
    expect(parseClaudeRateLimitInfo(null)).toEqual(EMPTY_LIMIT_STATE);
  });
});

describe("mergeLimitState", () => {
  it("keeps a window a sparse update did not mention", () => {
    const previous = parseRateLimitsBlock({
      primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: NOW + 600 },
      secondary: { usedPercent: 8, windowDurationMins: 10_080, resetsAt: NOW + 90_000 },
    });
    const update = parseClaudeRateLimitInfo({ rateLimitType: "five_hour", utilization: 0.55 });

    const merged = mergeLimitState(previous, update, NOW);
    expect(merged.short?.usedPercent).toBeCloseTo(55, 5);
    expect(merged.long?.usedPercent).toBe(8);
  });

  it("drops a carried-forward window whose reset has already passed", () => {
    const stale = parseRateLimitsBlock({
      primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: NOW - 10 },
    });

    expect(mergeLimitState(stale, EMPTY_LIMIT_STATE, NOW)).toEqual(EMPTY_LIMIT_STATE);
  });
});

describe("window state", () => {
  it("reports a window whose reset has passed as closed", () => {
    const stale = parseRateLimitsBlock({
      primary: { used_percent: 97, window_minutes: 300, resets_at: NOW - 60 },
    });

    expect(windowClosed(stale, NOW)).toBe(true);
    expect(nextResetEpoch(stale, NOW)).toBeNull();
  });

  it("adds a buffer so work resumes after the window flips", () => {
    const state = parseRateLimitsBlock({
      primary: { used_percent: 97, window_minutes: 300, resets_at: NOW + 120 },
    });

    expect(nextResetEpoch(state, NOW)).toBe(NOW + 180);
  });

  it("grades headroom", () => {
    const at = (usedPercent: number) =>
      limitLevel(
        parseRateLimitsBlock({ primary: { used_percent: usedPercent, window_minutes: 300 } }),
      );

    expect(at(2)).toBe("fresh");
    expect(at(50)).toBe("normal");
    expect(at(80)).toBe("low");
    expect(at(98)).toBe("exhausted");
    expect(limitLevel(parseStatuslineLimits(null))).toBe("unknown");
  });
});

describe("parseResetEpochFromText", () => {
  it("takes a near-future epoch out of the failure text", () => {
    const text = `usage limit reached, resets_at ${NOW + 1800}`;
    expect(parseResetEpochFromText(text, NOW)).toBe(NOW + 1800);
  });

  it("ignores a long number that is not a plausible reset", () => {
    expect(parseResetEpochFromText("usage limit reached 1234567890123", NOW)).toBeNull();
  });

  it("refuses a bare hour with no minutes or meridiem", () => {
    expect(parseResetEpochFromText("resets 5 times", NOW)).toBeNull();
  });

  it("reads a clock time in a named zone", () => {
    const epoch = parseResetEpochFromText("resets 3:40am (America/Indianapolis)", NOW);
    expect(epoch).not.toBeNull();
    expect(epoch! > NOW).toBe(true);

    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Indianapolis",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(epoch! * 1000);
    expect(parts.find((part) => part.type === "hour")?.value).toBe("03");
    expect(parts.find((part) => part.type === "minute")?.value).toBe("40");
  });

  it("rolls a time that has already passed today to tomorrow", () => {
    const epoch = parseResetEpochFromText("resets at 11:00pm (UTC)", NOW);
    expect(epoch).not.toBeNull();
    expect(epoch! - NOW).toBeLessThanOrEqual(24 * 3600);
    expect(epoch! > NOW).toBe(true);
  });

  it("falls back to the machine zone when the named one is junk", () => {
    expect(parseResetEpochFromText("resets at 4:00am (Not/AZone)", NOW)).toBeNull();
    expect(parseResetEpochFromText("resets at 4:00am", NOW)).not.toBeNull();
  });
});

describe("parseCswapList", () => {
  it("reads both windows for every managed account", () => {
    const accounts = parseCswapList({
      accounts: [
        {
          number: 1,
          email: "a@example.com",
          active: true,
          usage: {
            fiveHour: { pct: 30, resetsAt: "2026-09-22T23:30:00+00:00" },
            sevenDay: { pct: 43, resetsAt: "2026-09-25T04:00:00+00:00" },
          },
          usageFetchedAt: "2026-09-22T19:01:23Z",
        },
        { number: 2, email: "b@example.com", active: false, usageStatus: "error" },
      ],
    });

    expect(accounts).toHaveLength(2);
    expect(accounts[0]?.active).toBe(true);
    expect(accounts[0]?.state.short).toEqual({
      usedPercent: 30,
      resetsAt: Date.parse("2026-09-22T23:30:00Z") / 1000,
      windowMinutes: 300,
    });
    expect(accounts[0]?.state.long?.usedPercent).toBe(43);
    expect(accounts[1]?.state).toBe(EMPTY_LIMIT_STATE);
  });

  it("returns nothing for output it does not recognise", () => {
    expect(parseCswapList({ error: "nope" })).toEqual([]);
  });
});

describe("parseCodexSessionLimits", () => {
  it("takes the newest rate-limit reading in the log", () => {
    const line = (used: number) =>
      JSON.stringify({
        timestamp: "2026-09-22T19:03:28.587Z",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: used, window_minutes: 300, resets_at: NOW + 100 },
            secondary: { used_percent: 19, window_minutes: 10080, resets_at: NOW + 9000 },
            plan_type: "plus",
          },
        },
      });
    const result = parseCodexSessionLimits([line(10), "not json", line(89), ""].join("\n"));

    expect(result.planType).toBe("plus");
    expect(result.state.short?.usedPercent).toBe(89);
    expect(result.state.long?.usedPercent).toBe(19);
  });
});

describe("parseCursorAboutTier", () => {
  it("reads the tier line", () => {
    expect(parseCursorAboutTier("Model  Auto\nSubscription Tier   Pro\nOS darwin")).toBe("Pro");
    expect(parseCursorAboutTier("")).toBeNull();
  });
});
