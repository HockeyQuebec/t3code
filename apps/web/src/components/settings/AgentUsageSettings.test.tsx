import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import type { SpendEntry } from "@t3tools/contracts";

const testState = vi.hoisted(() => ({
  useAgentLimits: vi.fn(),
  useSpendSummary: vi.fn(),
  useHarnessCatalog: vi.fn(),
}));

vi.mock("../../lib/agentLimitsState", () => ({
  useAgentLimits: testState.useAgentLimits,
  useSpendSummary: testState.useSpendSummary,
  useHarnessCatalog: testState.useHarnessCatalog,
}));

import { AgentUsageSettings } from "./AgentUsageSettings";

const mockNow = DateTime.makeUnsafe("2024-01-01T12:00:00.000Z");

describe("AgentUsageSettings", () => {
  it("shows empty state when no provider data", () => {
    testState.useAgentLimits.mockReturnValue({
      data: { readAt: mockNow, providers: [] },
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });
    testState.useSpendSummary.mockReturnValue({
      data: null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });
    testState.useHarnessCatalog.mockReturnValue({
      data: null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });

    const markup = renderToStaticMarkup(<AgentUsageSettings />);
    expect(markup).toContain("Providers report headroom as they run");
  });

  it("renders spend section with estimate legend", () => {
    testState.useAgentLimits.mockReturnValue({
      data: null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });

    const mockSpendData = {
      readAt: mockNow,
      window: "today" as const,
      since: Option.some(mockNow),
      truncated: false,
      total: {
        key: "total",
        driver: Option.none(),
        model: Option.none(),
        tokens: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens: 1500,
        },
        reportedCostUsd: 0.05,
        estimatedCostUsd: 0.02,
        costSource: "mixed" as const,
        turns: 1,
      } as SpendEntry,
      byDriver: [] as ReadonlyArray<SpendEntry>,
      byModel: [] as ReadonlyArray<SpendEntry>,
      assumptions: [],
    };

    testState.useSpendSummary.mockReturnValue({
      data: mockSpendData,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });

    testState.useHarnessCatalog.mockReturnValue({
      data: null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });

    const markup = renderToStaticMarkup(<AgentUsageSettings />);

    expect(markup).toContain("Cost Legend");
    expect(markup).toContain("Reported + Estimated");
    expect(markup).toContain("Reported cost only");
  });

  it("shows truncated notice when spend data is truncated", () => {
    testState.useAgentLimits.mockReturnValue({
      data: null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });

    const mockSpendData = {
      readAt: mockNow,
      window: "today" as const,
      since: Option.some(mockNow),
      truncated: true,
      total: {
        key: "total",
        driver: Option.none(),
        model: Option.none(),
        tokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
        },
        reportedCostUsd: 0,
        estimatedCostUsd: 0,
        costSource: "none" as const,
        turns: 0,
      } as SpendEntry,
      byDriver: [] as ReadonlyArray<SpendEntry>,
      byModel: [] as ReadonlyArray<SpendEntry>,
      assumptions: [],
    };

    testState.useSpendSummary.mockReturnValue({
      data: mockSpendData,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });

    testState.useHarnessCatalog.mockReturnValue({
      data: null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });

    const markup = renderToStaticMarkup(<AgentUsageSettings />);

    expect(markup).toContain("This ledger covers work since the server started");
  });

  it("renders harness unavailable reasons", () => {
    testState.useAgentLimits.mockReturnValue({
      data: null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });

    testState.useSpendSummary.mockReturnValue({
      data: null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });

    const mockCatalog = {
      readAt: mockNow,
      configPath: Option.none(),
      binaryPath: Option.none(),
      workflows: [],
      unavailable: Option.some("noConfig" as const),
    };

    testState.useHarnessCatalog.mockReturnValue({
      data: mockCatalog,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });

    const markup = renderToStaticMarkup(<AgentUsageSettings cwd="/test/project" />);

    expect(markup).toContain("This project does not declare an .agent-harness.toml");
  });

  it("shows empty state when no cwd provided", () => {
    testState.useAgentLimits.mockReturnValue({
      data: null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });

    testState.useSpendSummary.mockReturnValue({
      data: null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });

    testState.useHarnessCatalog.mockReturnValue({
      data: null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });

    const markup = renderToStaticMarkup(<AgentUsageSettings />);

    expect(markup).toContain("Project workspace required");
  });
});
