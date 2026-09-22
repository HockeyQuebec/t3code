import { describe, expect, it } from "vite-plus/test";

import { patchHarnessConfig } from "./harnessConfigPatch.ts";

/** An excerpt of a real `.agent-harness.toml`: comments, mixed keys, a workflow table. */
const CONFIG = `version = 1

# The adaptive workflow spends Codex Luna first, uses standard-speed Cursor
# Composer for ordinary bulk work.
[agents.planner]
provider = "claude"
mode = "read"
model = "haiku"
reasoning = "low"
timeout_seconds = 600
allowed_tools = ["Read", "Glob", "Grep"]

# Cursor's non-interactive CLI requires --force, which Agent Harness exposes
# only through this explicit unsafe opt-in.
[agents.cursor_composer]
provider = "cursor"
mode = "write"
model = "composer-2.5"
timeout_seconds = 2400
unsafe_bypass = true

[agents.reviewer]
provider = "claude"
mode = "read"
model = "sonnet"
reasoning = "high"
timeout_seconds = 1200

[workflows.evaluated_change]
entrypoint = "plan"
max_steps = 13

[workflows.evaluated_change.nodes.plan]
kind = "agent"
agent = "codex_architect"
prompt = """
Produce a compact implementation plan.
"""
`;

describe("patchHarnessConfig", () => {
  it("rewrites provider and model on one role only", () => {
    const result = patchHarnessConfig(CONFIG, {
      planner: { driver: "codex", model: "gpt-5.6-luna" },
    });

    expect(result.applied).toEqual(["planner"]);
    expect(result.missingRoles).toEqual([]);
    expect(result.toml).toContain(
      '[agents.planner]\nprovider = "codex"\nmode = "read"\nmodel = "gpt-5.6-luna"\n',
    );
    // The other roles keep their own provider/model.
    expect(result.toml).toContain('[agents.cursor_composer]\nprovider = "cursor"');
    expect(result.toml).toContain(
      '[agents.reviewer]\nprovider = "claude"\nmode = "read"\nmodel = "sonnet"',
    );
  });

  it("leaves comments, unrelated tables, and untouched keys byte-for-byte", () => {
    const result = patchHarnessConfig(CONFIG, { planner: { model: "opus" } });

    const before = CONFIG.split("\n");
    const after = result.toml.split("\n");
    expect(after.length).toBe(before.length);
    const differing = after
      .map((line, index) => (line === before[index] ? null : index))
      .filter((index): index is number => index !== null);
    expect(differing.length).toBe(1);
    expect(before[differing[0] ?? 0]).toBe('model = "haiku"');
    expect(after[differing[0] ?? 0]).toBe('model = "opus"');
  });

  it("inserts reasoning into a role that had none", () => {
    const result = patchHarnessConfig(CONFIG, {
      cursor_composer: { reasoning: "high" },
    });

    expect(result.applied).toEqual(["cursor_composer"]);
    expect(result.toml).toContain(
      '[agents.cursor_composer]\nreasoning = "high"\nprovider = "cursor"',
    );
    // Nothing else in the file gained a reasoning key.
    expect(result.toml.split("\n").filter((line) => line.startsWith("reasoning = ")).length).toBe(
      3,
    );
  });

  it("reports an override for a role with no table and changes nothing", () => {
    const result = patchHarnessConfig(CONFIG, { nonexistent: { driver: "codex" } });

    expect(result.applied).toEqual([]);
    expect(result.missingRoles).toEqual(["nonexistent"]);
    expect(result.toml).toBe(CONFIG);
  });

  it("treats an all-undefined override as a no-op", () => {
    const result = patchHarnessConfig(CONFIG, { planner: {} });

    expect(result.applied).toEqual([]);
    expect(result.missingRoles).toEqual([]);
    expect(result.toml).toBe(CONFIG);
  });

  it("returns the input unchanged for empty overrides", () => {
    const result = patchHarnessConfig(CONFIG, {});

    expect(result.toml).toBe(CONFIG);
    expect(result.applied).toEqual([]);
    expect(result.missingRoles).toEqual([]);
  });

  it("escapes quotes and backslashes in values", () => {
    const result = patchHarnessConfig(CONFIG, {
      planner: { model: 'we"ird\\model' },
    });

    expect(result.toml).toContain('model = "we\\"ird\\\\model"');
  });

  it("does not confuse a role whose name is a prefix of another", () => {
    const config = `[agents.review]
provider = "claude"
model = "haiku"

[agents.reviewer]
provider = "claude"
model = "sonnet"
`;
    const result = patchHarnessConfig(config, { review: { model: "opus" } });

    expect(result.applied).toEqual(["review"]);
    expect(result.toml).toBe(`[agents.review]
provider = "claude"
model = "opus"

[agents.reviewer]
provider = "claude"
model = "sonnet"
`);
  });

  it("patches several roles in one pass and reports each", () => {
    const result = patchHarnessConfig(CONFIG, {
      planner: { driver: "codex" },
      reviewer: { model: "opus", reasoning: "xhigh" },
      ghost: { model: "sonnet" },
    });

    expect(result.applied).toEqual(["planner", "reviewer"]);
    expect(result.missingRoles).toEqual(["ghost"]);
    expect(result.toml).toContain('[agents.planner]\nprovider = "codex"');
    expect(result.toml).toContain('model = "opus"\nreasoning = "xhigh"\ntimeout_seconds = 1200');
  });

  it("tolerates arbitrary whitespace around the assignment", () => {
    const config = `[agents.planner]
   provider   =    "claude"
model="haiku"
`;
    const result = patchHarnessConfig(config, { planner: { driver: "codex", model: "opus" } });

    expect(result.toml).toBe(`[agents.planner]
   provider   =    "codex"
model="opus"
`);
  });
});
