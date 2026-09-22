import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import type { HarnessWorkflowSummary } from "@t3tools/contracts";

const testState = vi.hoisted(() => ({
  useHarnessCatalog: vi.fn(),
  usePrimarySettings: vi.fn(),
  useUpdatePrimarySettings: vi.fn(),
}));

vi.mock("../../lib/agentLimitsState", () => ({
  useHarnessCatalog: testState.useHarnessCatalog,
}));

vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: testState.usePrimarySettings,
  useUpdatePrimarySettings: testState.useUpdatePrimarySettings,
}));

import { HarnessAgentsControl, HarnessAgentsPanel } from "./HarnessAgentsControl";

const workflow = {
  name: "evaluated_change",
  drivers: ["codex", "claudeAgent"],
  providerKey: "codex,claudeAgent",
  description: "Plans a change, implements it, then has a second agent review it.",
  steps: ["plan", "implement", "tests", "review"],
  stepCount: 4,
  recommended: true,
  roles: [
    {
      name: "implementer",
      driver: "codex",
      mode: "write",
      model: Option.some("gpt-5-codex"),
      reasoning: Option.none(),
      timeoutSeconds: Option.none(),
    },
    {
      name: "reviewer",
      driver: "claudeAgent",
      mode: "read",
      model: Option.none(),
      reasoning: Option.none(),
      timeoutSeconds: Option.none(),
    },
    {
      name: "planner",
      driver: "codex",
      mode: "read",
      model: Option.none(),
      reasoning: Option.none(),
      timeoutSeconds: Option.none(),
    },
  ],
} as unknown as HarnessWorkflowSummary;

const catalogWith = (workflows: ReadonlyArray<HarnessWorkflowSummary>) => ({
  data: { workflows },
  error: null,
  isPending: false,
  refresh: vi.fn(),
});

function setSettings(roleOverrides: Record<string, Record<string, unknown>>) {
  const providers = { harness: { roleOverrides } };
  testState.usePrimarySettings.mockImplementation(
    (select: (settings: { providers: typeof providers }) => unknown) => select({ providers }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  testState.useHarnessCatalog.mockReturnValue(catalogWith([workflow]));
  testState.useUpdatePrimarySettings.mockReturnValue(vi.fn());
  setSettings({});
});

describe("HarnessAgentsControl", () => {
  it("renders nothing when no harness workflow is selected", () => {
    const markup = renderToStaticMarkup(<HarnessAgentsControl workflow={null} cwd="/repo" />);
    expect(markup).toBe("");
  });

  it("renders nothing without a project directory", () => {
    testState.useHarnessCatalog.mockReturnValue(catalogWith([]));
    const markup = renderToStaticMarkup(
      <HarnessAgentsControl workflow="evaluated_change" cwd={null} />,
    );
    expect(markup).toBe("");
  });

  it("renders nothing when the catalog has no matching workflow", () => {
    testState.useHarnessCatalog.mockReturnValue(catalogWith([]));
    const markup = renderToStaticMarkup(
      <HarnessAgentsControl workflow="evaluated_change" cwd="/repo" />,
    );
    expect(markup).toBe("");
  });

  it("labels the trigger with the workflow's role count", () => {
    const markup = renderToStaticMarkup(
      <HarnessAgentsControl workflow="evaluated_change" cwd="/repo" />,
    );
    expect(markup).toContain("Agents · 3");
    expect(markup).not.toContain("changed");
  });

  it("marks the trigger when overrides are active", () => {
    setSettings({ evaluated_change: { implementer: { driver: "grok" } } });
    const markup = renderToStaticMarkup(
      <HarnessAgentsControl workflow="evaluated_change" cwd="/repo" />,
    );
    expect(markup).toContain("Agents · 3 · 1 changed");
  });
});

describe("HarnessAgentsPanel", () => {
  it("shows the humanised name, description and step sequence", () => {
    const markup = renderToStaticMarkup(
      <HarnessAgentsPanel workflow={workflow} overrides={{}} onChange={vi.fn()} />,
    );
    expect(markup).toContain("Evaluated change");
    expect(markup).toContain("then has a second agent review it");
    expect(markup).toContain("plan → implement → tests → review");
  });

  it("omits the description and steps lines when the server has not filled them in", () => {
    const bare = { ...workflow, description: "", steps: [] } as unknown as HarnessWorkflowSummary;
    const markup = renderToStaticMarkup(
      <HarnessAgentsPanel workflow={bare} overrides={{}} onChange={vi.fn()} />,
    );
    expect(markup).not.toContain("→");
    expect(markup).toContain("Evaluated change");
  });

  it("offers a reset once an override exists", () => {
    const markup = renderToStaticMarkup(
      <HarnessAgentsPanel
        workflow={workflow}
        overrides={{ implementer: { driver: "grok" } }}
        onChange={vi.fn()}
      />,
    );
    expect(markup).toContain("Reset to defaults");
  });
});
