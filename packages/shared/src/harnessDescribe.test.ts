import { describe, expect, it } from "vite-plus/test";

import {
  describeHarnessWorkflow,
  harnessWorkflowSteps,
  harnessWorkflowWrites,
} from "./harnessDescribe.ts";
import type { HarnessAgentRole, HarnessWorkflow } from "./harnessWorkflow.ts";

const agents: ReadonlyArray<HarnessAgentRole> = [
  { name: "planner", provider: "claude", mode: "read" },
  { name: "implementer", provider: "codex", mode: "write" },
  { name: "reviewer", provider: "claude", mode: "read" },
];

function node(name: string, agent?: string) {
  return { name, kind: "agent", ...(agent === undefined ? {} : { agent }) };
}

const evaluatedChange: HarnessWorkflow = {
  name: "evaluated_change",
  providers: ["claude", "codex"],
  nodes: [
    node("plan", "planner"),
    node("implement", "implementer"),
    node("changed"),
    node("typecheck"),
    node("lint"),
    node("tests"),
    node("repair", "implementer"),
    node("review", "reviewer"),
  ],
};

const reviewOnly: HarnessWorkflow = {
  name: "evaluated_review",
  providers: ["claude"],
  nodes: [node("review", "reviewer")],
};

describe("harnessWorkflowSteps", () => {
  it("lists node names in declared order", () => {
    expect(harnessWorkflowSteps(evaluatedChange).slice(0, 3)).toEqual([
      "plan",
      "implement",
      "changed",
    ]);
  });
});

describe("harnessWorkflowWrites", () => {
  it("is true when any role may modify the worktree", () => {
    expect(harnessWorkflowWrites(evaluatedChange, agents)).toBe(true);
  });

  it("is false for a review-only workflow", () => {
    expect(harnessWorkflowWrites(reviewOnly, agents)).toBe(false);
  });
});

describe("describeHarnessWorkflow", () => {
  it("describes a multi-provider change workflow from its steps", () => {
    const text = describeHarnessWorkflow(evaluatedChange, agents);

    expect(text).toContain("Makes changes in an isolated worktree");
    expect(text).toContain("Runs on claude and codex");
    expect(text).toContain("plans the change");
    expect(text).toContain("reviews the work");
  });

  it("says plainly when a workflow changes nothing", () => {
    const text = describeHarnessWorkflow(reviewOnly, agents);

    expect(text).toContain("Reads only");
    expect(text).toContain("Runs on claude.");
    expect(text).toContain("reviews the work");
  });

  it("does not repeat a phrase when a node is revisited", () => {
    const looping: HarnessWorkflow = {
      name: "loop",
      providers: ["codex"],
      nodes: [
        node("implement", "implementer"),
        node("tests"),
        node("implement_again", "implementer"),
      ],
    };

    const text = describeHarnessWorkflow(looping, agents);
    expect(text.match(/implements the change/g)).toHaveLength(1);
  });

  it("falls back to a node's own name when it is not a familiar step", () => {
    const custom: HarnessWorkflow = {
      name: "custom",
      providers: ["codex"],
      nodes: [node("smoke_screenshot", "implementer")],
    };

    expect(describeHarnessWorkflow(custom, agents)).toContain("smoke screenshot");
  });

  it("says so rather than inventing a sentence for an empty workflow", () => {
    expect(describeHarnessWorkflow({ name: "empty", providers: [] }, agents)).toBe(
      "Declares no steps.",
    );
  });
});
