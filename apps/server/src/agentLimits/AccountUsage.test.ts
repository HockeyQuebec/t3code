import { ThreadId } from "@t3tools/contracts";
import { EMPTY_ATTRIBUTION, type UsageTurn } from "@t3tools/shared/accountUsage";
import { describe, expect, it } from "vite-plus/test";

import { type AccountUsageState, summarizeAccounts, summarizeThread } from "./AccountUsage.ts";

const NOW = 1_000_000_000;
const CURRENT_RESET = NOW + 60 * 60 * 1000;

function turn(
  input: Partial<UsageTurn> & Pick<UsageTurn, "id" | "threadId" | "account">,
): UsageTurn {
  return {
    driver: "claudeAgent",
    model: null,
    atMillis: NOW - 1000,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    costUsd: 1,
    fiveHourPercent: 2,
    fiveHourResetsAt: CURRENT_RESET,
    weeklyPercent: 1,
    weeklyResetsAt: null,
    open: false,
    ...input,
  };
}

const state: AccountUsageState = {
  turns: [
    turn({ id: "1", threadId: "t1", account: "cswap-1" }),
    turn({ id: "2", threadId: "t1", account: "cswap-2", costUsd: 3 }),
    // Drawn from a 5h window that has since reset.
    turn({ id: "3", threadId: "t1", account: "cswap-1", fiveHourResetsAt: NOW - 1000 }),
    turn({ id: "4", threadId: "t2", account: "cswap-1" }),
  ],
  attribution: {
    "cswap-1": { ...EMPTY_ATTRIBUTION, otherFiveHour: 5, otherFiveHourResetsAt: CURRENT_RESET },
  },
  accounts: {
    "cswap-1": {
      label: "chuck@example.com",
      driver: "claudeAgent",
      fiveHour: { usedPercent: 20, resetsAt: CURRENT_RESET },
      weekly: null,
    },
    "cswap-2": {
      label: "parker@example.com",
      driver: "claudeAgent",
      fiveHour: { usedPercent: 10, resetsAt: CURRENT_RESET },
      weekly: null,
    },
  },
};

describe("summarizeThread", () => {
  it("totals a chat across accounts and counts only the live 5h window", () => {
    const usage = summarizeThread(state, ThreadId.make("t1"), NOW);
    expect(usage.turns).toBe(3);
    expect(usage.costUsd).toBe(5);
    expect(usage.tokens.totalTokens).toBe(300);
    expect(usage.fiveHourPercent).toBe(6);
    expect(usage.windowFiveHourPercent).toBe(4);
    expect(usage.byAccount.map((entry) => [entry.label, entry.turns])).toEqual([
      ["chuck@example.com", 2],
      ["parker@example.com", 1],
    ]);
  });
});

describe("summarizeAccounts", () => {
  it("splits an account's window between this device and others", () => {
    const chuck = summarizeAccounts(state, NOW).find((entry) => entry.account === "cswap-1")!;
    expect(chuck.turns).toBe(3);
    expect(chuck.fiveHourPercent).toBe(4);
    expect(chuck.otherFiveHourPercent).toBe(5);
  });
});
