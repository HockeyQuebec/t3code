import { describe, expect, it } from "vite-plus/test";

import { mergeHarnessConfigText } from "./harnessConfigMerge.ts";

const GLOBAL = `version = 1

# Every checkout without one of its own runs off this file.
[agents.planner]
provider = "claude"
mode = "read"

[agents.worker]
provider = "claude"
mode = "write"

[workflows.claude_team]
entrypoint = "plan"
workspace = "worktree"

[workflows.claude_team.nodes.plan]
kind = "agent"
agent = "planner"
prompt = """
Write the work order.
Sections are marked like [SECTION A].
"""
on_success = "implement"

[workflows.claude_team.nodes.implement]
kind = "agent"
agent = "worker"

[workflows.vibe_code]
entrypoint = "go"

[workflows.vibe_code.nodes.go]
kind = "agent"
agent = "worker"
`;

describe("mergeHarnessConfigText", () => {
  it("keeps global tables the repository does not mention", () => {
    const merged = mergeHarnessConfigText(
      GLOBAL,
      `version = 1

[workflows.deploy]
entrypoint = "ship"

[workflows.deploy.nodes.ship]
kind = "command"
command = ["make", "deploy"]
`,
    );

    expect(merged.overridden).toEqual([]);
    expect(merged.added).toEqual(["workflows.deploy"]);
    expect(merged.toml).toContain("[workflows.claude_team]");
    expect(merged.toml).toContain("[workflows.vibe_code]");
    expect(merged.toml).toContain("[workflows.deploy]");
    expect(merged.toml).toContain("[agents.planner]");
  });

  it("replaces a global table the repository redefines, nested tables and all", () => {
    const merged = mergeHarnessConfigText(
      GLOBAL,
      `version = 1

[workflows.claude_team]
entrypoint = "solo"

[workflows.claude_team.nodes.solo]
kind = "agent"
agent = "worker"
`,
    );

    expect(merged.overridden).toEqual(["workflows.claude_team"]);
    // The global workflow's nodes must not survive alongside the new ones:
    // a duplicate table is a hard error in the parser the harness itself uses.
    expect(merged.toml).not.toContain("[workflows.claude_team.nodes.plan]");
    expect(merged.toml).not.toContain("[workflows.claude_team.nodes.implement]");
    expect(merged.toml).toContain("[workflows.claude_team.nodes.solo]");
    // Untouched neighbours stay.
    expect(merged.toml).toContain("[workflows.vibe_code]");
    expect(merged.toml).toContain("[agents.worker]");
  });

  it("does not read a bracketed line inside a multi-line prompt as a table", () => {
    const merged = mergeHarnessConfigText(
      GLOBAL,
      `version = 1\n\n[agents.worker]\nprovider = "codex"\nmode = "write"\n`,
    );

    // `[SECTION A]` lives inside the global plan prompt; treating it as a
    // header would split that workflow in half and lose the rest of it.
    expect(merged.toml).toContain("Sections are marked like [SECTION A].");
    expect(merged.toml).toContain("[workflows.claude_team.nodes.implement]");
    expect(merged.overridden).toEqual(["agents.worker"]);
  });

  it("declares version once when both files declare it", () => {
    const merged = mergeHarnessConfigText(
      GLOBAL,
      `version = 1\n\n[workflows.extra]\nentrypoint = "x"\n`,
    );

    const declarations = merged.toml
      .split("\n")
      .filter((line) => line.trim().startsWith("version"));
    expect(declarations).toHaveLength(1);
  });

  it("returns the other side untouched when one is empty", () => {
    expect(mergeHarnessConfigText(GLOBAL, "").toml).toBe(GLOBAL);
    expect(mergeHarnessConfigText("", GLOBAL).toml).toBe(GLOBAL);
  });
});
