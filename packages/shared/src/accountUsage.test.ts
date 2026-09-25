import { describe, expect, it } from "vite-plus/test";

import {
  attributeReading,
  chooseClaudeSwitch,
  EMPTY_ATTRIBUTION,
  type AccountAttribution,
  type UsageTurn,
} from "./accountUsage.ts";

const RESET = 10_000_000;

function turn(id: string, threadId: string, costUsd: number, atMillis = 0): UsageTurn {
  return {
    id,
    threadId,
    account: "a",
    driver: "claudeAgent",
    model: null,
    atMillis,
    inputTokens: 100,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
    fiveHourPercent: 0,
    fiveHourResetsAt: null,
    weeklyPercent: 0,
    weeklyResetsAt: null,
    open: true,
  };
}

function reading(atMillis: number, fiveHour: number, weekly = 0) {
  return {
    atMillis,
    fiveHour: { usedPercent: fiveHour, resetsAt: RESET },
    weekly: { usedPercent: weekly, resetsAt: RESET * 2 },
  };
}

function fold(
  state: AccountAttribution,
  turns: ReadonlyArray<UsageTurn>,
  next: ReturnType<typeof reading>,
  running = false,
) {
  return attributeReading({ state, turns, account: "a", reading: next, running });
}

describe("attributeReading", () => {
  it("splits a rise across this device's turns by cost", () => {
    const base = fold(EMPTY_ATTRIBUTION, [], reading(0, 10));
    const result = fold(base.state, [turn("1", "t1", 3), turn("2", "t2", 1)], reading(1000, 18, 2));
    expect(result.turns.map((entry) => entry.fiveHourPercent)).toEqual([6, 2]);
    expect(result.turns.map((entry) => entry.weeklyPercent)).toEqual([1.5, 0.5]);
    expect(result.state.otherFiveHour).toBe(0);
  });

  it("charges a rise with no local turn to other devices", () => {
    const base = fold(EMPTY_ATTRIBUTION, [], reading(0, 10));
    const result = fold(base.state, [], reading(1000, 14));
    expect(result.state.otherFiveHour).toBe(4);
  });

  it("holds a rise seen mid-turn until the turn finishes", () => {
    const base = fold(EMPTY_ATTRIBUTION, [], reading(0, 10));
    const midTurn = fold(base.state, [], reading(1000, 15), true);
    expect(midTurn.state.pendingFiveHour).toBe(5);
    const done = fold(midTurn.state, [turn("1", "t1", 1, 1500)], reading(2000, 16));
    expect(done.turns[0]!.fiveHourPercent).toBe(6);
    expect(done.state.otherFiveHour).toBe(0);
  });

  it("counts from zero after the window resets", () => {
    const base = fold(EMPTY_ATTRIBUTION, [], reading(0, 90));
    const reset = attributeReading({
      state: base.state,
      turns: [turn("1", "t1", 1)],
      account: "a",
      reading: { atMillis: 1000, fiveHour: { usedPercent: 3, resetsAt: RESET * 3 }, weekly: null },
      running: false,
    });
    expect(reset.turns[0]!.fiveHourPercent).toBe(3);
  });

  it("closes a turn once the grace period has passed", () => {
    const base = fold(EMPTY_ATTRIBUTION, [], reading(0, 10));
    const result = fold(base.state, [turn("1", "t1", 1, 0)], reading(60 * 60 * 1000, 11));
    expect(result.turns[0]!.open).toBe(false);
  });
});

describe("chooseClaudeSwitch", () => {
  const account = (number: number, email: string, active: boolean, fiveHour: number) => ({
    number,
    email,
    active,
    fiveHour: { usedPercent: fiveHour, resetsAt: RESET },
    weekly: { usedPercent: 10, resetsAt: RESET },
  });

  it("leaves an account at its own ceiling", () => {
    const accounts = [account(1, "chuck", true, 31), account(2, "parker", false, 40)];
    expect(chooseClaudeSwitch(accounts, { chuck: 30 }, 0)).toBe(2);
  });

  it("stays below the ceiling", () => {
    const accounts = [account(1, "chuck", true, 20), account(2, "parker", false, 0)];
    expect(chooseClaudeSwitch(accounts, { chuck: 30 }, 0)).toBeNull();
  });

  it("runs an account without a ceiling until it is full", () => {
    const accounts = [account(1, "chuck", false, 10), account(2, "parker", true, 99)];
    expect(chooseClaudeSwitch(accounts, { chuck: 30 }, 0)).toBeNull();
    const full = [account(1, "chuck", false, 10), account(2, "parker", true, 100)];
    expect(chooseClaudeSwitch(full, { chuck: 30 }, 0)).toBe(1);
  });

  it("stays put when nothing else has room", () => {
    const accounts = [account(1, "chuck", false, 35), account(2, "parker", true, 100)];
    expect(chooseClaudeSwitch(accounts, { chuck: 30 }, 0)).toBeNull();
  });

  it("treats a window past its reset as empty", () => {
    const parker = {
      ...account(2, "parker", true, 100),
      fiveHour: { usedPercent: 100, resetsAt: RESET * 2 },
    };
    const accounts = [account(1, "chuck", false, 50), parker];
    expect(chooseClaudeSwitch(accounts, { chuck: 30 }, RESET + 1)).toBe(1);
  });
});
