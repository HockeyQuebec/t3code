import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import type { HarnessWorkflowSummary } from "@t3tools/contracts";

import {
  applyRoleOverride,
  HarnessRoleControls,
  type HarnessRoleOverrides,
  hasRoleOverrides,
} from "./HarnessRoleControls";

const workflow = {
  name: "evaluated_change",
  drivers: ["codex", "claudeAgent"],
  providerKey: "codex,claudeAgent",
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
  ],
} as unknown as HarnessWorkflowSummary;

describe("applyRoleOverride", () => {
  it("sets a provider override for a role", () => {
    const next = applyRoleOverride({}, "implementer", "driver", "grok");
    expect(next).toEqual({ implementer: { driver: "grok" } });
  });

  it("keeps other fields and other roles untouched", () => {
    const current: HarnessRoleOverrides = {
      implementer: { driver: "grok", model: "grok-code" },
      reviewer: { reasoning: "high" },
    };
    const next = applyRoleOverride(current, "implementer", "reasoning", "low");
    expect(next).toEqual({
      implementer: { driver: "grok", model: "grok-code", reasoning: "low" },
      reviewer: { reasoning: "high" },
    });
    // The input record is not mutated.
    expect(current.implementer).toEqual({ driver: "grok", model: "grok-code" });
  });

  it("clearing a field removes that key", () => {
    const next = applyRoleOverride(
      { implementer: { driver: "grok", model: "grok-code" } },
      "implementer",
      "driver",
      "",
    );
    expect(next).toEqual({ implementer: { model: "grok-code" } });
    expect(Object.hasOwn(next.implementer ?? {}, "driver")).toBe(false);
  });

  it("prunes a role once its last override is cleared", () => {
    const next = applyRoleOverride(
      { implementer: { model: "grok-code" }, reviewer: { driver: "codex" } },
      "implementer",
      "model",
      "",
    );
    expect(next).toEqual({ reviewer: { driver: "codex" } });
    expect(Object.hasOwn(next, "implementer")).toBe(false);
  });

  it("treats a whitespace-only value as cleared", () => {
    const next = applyRoleOverride({ reviewer: { model: "sonnet" } }, "reviewer", "model", "   ");
    expect(next).toEqual({});
    expect(hasRoleOverrides(next)).toBe(false);
  });
});

describe("HarnessRoleControls", () => {
  it("renders each role with its declared default in the provider label and model placeholder", () => {
    const markup = renderToStaticMarkup(
      <HarnessRoleControls workflow={workflow} overrides={{}} onChange={vi.fn()} />,
    );

    expect(markup).toContain("implementer");
    expect(markup).toContain("Can modify");
    expect(markup).toContain("reviewer");
    expect(markup).toContain("Inspector");
    expect(markup).toContain("Default (codex)");
    expect(markup).toContain("Default (claudeAgent)");
    expect(markup).toContain('placeholder="gpt-5-codex"');
    expect(markup).toContain('placeholder="provider default"');
  });

  it("explains what an override does", () => {
    const markup = renderToStaticMarkup(
      <HarnessRoleControls workflow={workflow} overrides={{}} onChange={vi.fn()} />,
    );
    expect(markup).toContain("still runs its declared steps");
  });

  it("hides the reset button until an override exists", () => {
    const withoutOverrides = renderToStaticMarkup(
      <HarnessRoleControls workflow={workflow} overrides={{}} onChange={vi.fn()} />,
    );
    expect(withoutOverrides).not.toContain("Reset to defaults");

    const withOverrides = renderToStaticMarkup(
      <HarnessRoleControls
        workflow={workflow}
        overrides={{ implementer: { driver: "grok" } }}
        onChange={vi.fn()}
      />,
    );
    expect(withOverrides).toContain("Reset to defaults");
  });

  it("renders nothing for a workflow with no roles", () => {
    const roleless = { ...workflow, roles: [] } as unknown as HarnessWorkflowSummary;
    const markup = renderToStaticMarkup(
      <HarnessRoleControls workflow={roleless} overrides={{}} onChange={vi.fn()} />,
    );
    expect(markup).toBe("");
  });
});
