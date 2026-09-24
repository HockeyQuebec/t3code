import type { ProviderLimitSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  formatCountdown,
  formatSpend,
  formatUsd,
  rankLimits,
  toLimitAccounts,
  windowLabel,
} from "./agentLimitsView";

const NOW = 1_760_000_000_000;

function snapshot(
  overrides: {
    readonly instanceId?: string;
    readonly usedPercent?: number;
    readonly resetsInSeconds?: number | null;
    readonly windowMinutes?: number;
    readonly level?: ProviderLimitSnapshot["level"];
  } = {},
): ProviderLimitSnapshot {
  const {
    instanceId = "claude",
    usedPercent = 50,
    resetsInSeconds = 3600,
    windowMinutes = 300,
    level = "normal",
  } = overrides;

  const window = {
    usedPercent,
    resetsAt:
      resetsInSeconds === null
        ? Option.none()
        : Option.some(DateTime.makeUnsafe(NOW + resetsInSeconds * 1000)),
    windowMinutes: Option.some(windowMinutes),
  };

  return {
    instanceId,
    driver: instanceId,
    label: instanceId,
    short: Option.some(window),
    long: Option.none(),
    binding: Option.some(window),
    level,
    source: "providerSession",
    observedAt: Option.none(),
  } as ProviderLimitSnapshot;
}

describe("formatCountdown", () => {
  it("drops precision as the wait grows", () => {
    expect(formatCountdown(0)).toBe("now");
    expect(formatCountdown(-5)).toBe("now");
    expect(formatCountdown(45)).toBe("45s");
    expect(formatCountdown(90)).toBe("1m");
    expect(formatCountdown(3 * 3600 + 12 * 60)).toBe("3h 12m");
    expect(formatCountdown(2 * 3600)).toBe("2h");
    expect(formatCountdown(50 * 3600)).toBe("2d 2h");
  });
});

describe("windowLabel", () => {
  it("names the window a percentage is measured against", () => {
    expect(windowLabel(300)).toBe("5h window");
    expect(windowLabel(10_080)).toBe("weekly");
    expect(windowLabel(30)).toBe("30m window");
    expect(windowLabel(null)).toBeNull();
    expect(windowLabel(0)).toBeNull();
  });
});

describe("rankLimits", () => {
  it("puts the provider closest to running out first", () => {
    const ranked = rankLimits(
      [
        snapshot({ instanceId: "codex", usedPercent: 12 }),
        snapshot({ instanceId: "claude", usedPercent: 88 }),
      ],
      NOW,
    );

    expect(ranked.map((row) => row.instanceId)).toEqual(["claude", "codex"]);
    expect(ranked[0]?.resetsIn).toBe("1h");
    expect(ranked[0]?.windowLabel).toBe("5h window");
  });

  it("marks a reading whose window has already reset as stale", () => {
    const ranked = rankLimits([snapshot({ usedPercent: 97, resetsInSeconds: -30 })], NOW);

    expect(ranked[0]?.stale).toBe(true);
  });

  it("leaves a provider that never named a reset without a countdown", () => {
    const ranked = rankLimits([snapshot({ resetsInSeconds: null })], NOW);

    expect(ranked[0]?.resetsIn).toBeNull();
    expect(ranked[0]?.stale).toBe(false);
  });
});

describe("spend formatting", () => {
  it("marks a partly modelled total with a tilde", () => {
    expect(formatSpend(1.5, 0)).toBe("$1.50");
    expect(formatSpend(1.5, 0.25)).toBe("~$1.75");
    expect(formatSpend(0, 0)).toBe("$0.00");
  });

  it("does not round a real cost away to zero", () => {
    expect(formatUsd(0.004)).toBe("<$0.01");
  });
});

describe("toLimitAccounts", () => {
  it("lists Claude accounts first and labels each window by its length", () => {
    const codex = snapshot({ instanceId: "codex", usedPercent: 89 });
    const claude = {
      ...snapshot({ instanceId: "cswap-1", usedPercent: 30, resetsInSeconds: 3600 }),
      driver: "claudeAgent",
      detail: "active",
      long: Option.some({
        usedPercent: 43,
        resetsAt: Option.some(DateTime.makeUnsafe(NOW - 1000)),
        windowMinutes: Option.some(10080),
      }),
    } as ProviderLimitSnapshot;

    const [first, second] = toLimitAccounts([codex, claude], NOW);

    expect(first?.instanceId).toBe("cswap-1");
    expect(first?.detail).toBe("active");
    expect(first?.windows).toEqual([
      { label: "5h", usedPercent: 30, resetsIn: "1h", stale: false },
      { label: "7d", usedPercent: 43, resetsIn: "now", stale: true },
    ]);
    expect(second?.instanceId).toBe("codex");
  });
});
