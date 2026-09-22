import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_RATES,
  mergeRateOverrides,
  priceTurn,
  rateAssumptions,
  rateCost,
  rateFor,
} from "./tokenPricing.ts";

describe("rateFor", () => {
  it("prefers the longest matching needle", () => {
    expect(rateFor("claude-opus-5", "claude").key).toBe("opus");
    expect(rateFor("gpt-5.6-sol", "codex").key).toBe("gpt-5");
    expect(rateFor("composer-2.5-fast", "cursor").key).toBe("composer-2.5-fast");
  });

  it("matches cursor's auto only as an exact id", () => {
    expect(rateFor("auto", "cursor").key).toBe("auto");
    // A future model whose name merely contains "auto" must not be priced as Cursor Auto.
    expect(rateFor("autopilot-9", "grok").key).toBe("unknown");
  });

  it("falls back to what the provider usually runs", () => {
    expect(rateFor(null, "codex").key).toBe("gpt-5");
    expect(rateFor("", "claude").key).toBe("sonnet");
    expect(rateFor(null, "grok").key).toBe("unknown");
  });
});

describe("rateCost", () => {
  it("prices each token class separately", () => {
    const cost = rateCost(DEFAULT_RATES.sonnet!, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });

    // 3.00 input + 15.00 output + 0.30 read + 3.75 write
    expect(cost).toBeCloseTo(22.05, 5);
  });
});

describe("priceTurn", () => {
  it("keeps a reported cost and estimates nothing on top of it", () => {
    const priced = priceTurn({
      provider: "claude",
      model: "claude-sonnet-5",
      reportedCostUsd: 0.42,
      inputTokens: 500_000,
      outputTokens: 10_000,
    });

    expect(priced.reportedCostUsd).toBe(0.42);
    expect(priced.estimatedCostUsd).toBe(0);
    expect(priced.costSource).toBe("reported");
  });

  it("estimates when the provider priced nothing", () => {
    const priced = priceTurn({
      provider: "codex",
      model: "gpt-5.6-terra",
      inputTokens: 1_000_000,
      outputTokens: 100_000,
    });

    expect(priced.reportedCostUsd).toBe(0);
    expect(priced.costSource).toBe("estimated");
    expect(priced.rateSource).toBe("assumed");
    expect(priced.estimatedCostUsd).toBeCloseTo(1.25 + 1.0, 5);
  });

  it("reports none when there is nothing to price", () => {
    expect(priceTurn({ provider: "codex" }).costSource).toBe("none");
  });
});

describe("mergeRateOverrides", () => {
  it("replaces only the columns given and keeps provenance", () => {
    const table = mergeRateOverrides({ sonnet: { input: 2.0 } });

    expect(table.sonnet?.input).toBe(2.0);
    expect(table.sonnet?.output).toBe(DEFAULT_RATES.sonnet?.output);
    expect(table.sonnet?.source).toBe("published");
    expect(table.sonnet?.note).toBe("set in settings");
  });

  it("adds a brand-new row on top of the unknown rate", () => {
    const table = mergeRateOverrides({ "my-model": { input: 1, output: 2 } });

    expect(table["my-model"]?.input).toBe(1);
    expect(table["my-model"]?.source).toBe("assumed");
  });

  it("ignores an override with no usable columns", () => {
    const table = mergeRateOverrides({ sonnet: { note: "hello" } });
    expect(table.sonnet).toEqual(DEFAULT_RATES.sonnet);
  });
});

describe("rateAssumptions", () => {
  it("lists each used row once, sorted", () => {
    const rows = rateAssumptions(["sonnet", "gpt-5", "sonnet"]);
    expect(rows.map((row) => row.key)).toEqual(["gpt-5", "sonnet"]);
    expect(rows[0]?.source).toBe("assumed");
  });
});
