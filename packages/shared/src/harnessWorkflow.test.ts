import { describe, expect, it } from "vite-plus/test";

import {
  HARNESS_CONFIG_ENV,
  WORKFLOW_CONFIG_NAMES,
  globalHarnessConfigCandidates,
  normalizeHarnessConfig,
  providerKey,
  selectWorkflow,
} from "./harnessWorkflow.ts";

describe("providerKey", () => {
  it("orders providers canonically", () => {
    expect(providerKey(["cursor", "claude"])).toBe("claude,cursor");
  });

  it("handles single provider", () => {
    expect(providerKey(["claude"])).toBe("claude");
  });

  it("handles full provider set", () => {
    expect(providerKey(["claude", "codex", "cursor", "grok", "opencode"])).toBe(
      "claude,codex,cursor,grok,opencode",
    );
  });

  it("deduplicates providers", () => {
    expect(providerKey(["claude", "claude", "cursor"])).toBe("claude,cursor");
  });

  it("returns empty string for empty set", () => {
    expect(providerKey([])).toBe("");
  });

  it("ignores unknown providers", () => {
    expect(providerKey(["claude", "unknown", "cursor"])).toBe("claude,cursor");
  });

  it("handles Set input", () => {
    expect(providerKey(new Set(["cursor", "claude"]))).toBe("claude,cursor");
  });
});

describe("selectWorkflow", () => {
  it("selects auto_<key> workflow with rank 0", () => {
    const workflows = [
      {
        name: "other",
        providers: ["claude", "cursor"],
        entrypoint: "test",
      },
      {
        name: "auto_claude_cursor",
        providers: ["claude", "cursor"],
        entrypoint: "test",
      },
    ];
    const result = selectWorkflow(["cursor", "claude"], workflows);
    expect(result).toBe("auto_claude_cursor");
  });

  it("selects model_council when full portfolio", () => {
    const workflows = [
      {
        name: "other",
        providers: ["claude", "codex", "cursor", "grok", "opencode"],
        entrypoint: "test",
      },
      {
        name: "model_council",
        providers: ["claude", "codex", "cursor", "grok", "opencode"],
        entrypoint: "test",
      },
    ];
    const result = selectWorkflow(["claude", "codex", "cursor", "grok", "opencode"], workflows);
    expect(result).toBe("model_council");
  });

  it("ranks evaluated_change second (rank 1)", () => {
    const workflows = [
      {
        name: "evaluated_change",
        providers: ["claude"],
        entrypoint: "test",
      },
      {
        name: "other",
        providers: ["claude"],
        entrypoint: "test",
      },
    ];
    const result = selectWorkflow(["claude"], workflows);
    expect(result).toBe("evaluated_change");
  });

  it("returns null when no matching provider set", () => {
    const workflows = [
      {
        name: "auto_claude",
        providers: ["claude"],
        entrypoint: "test",
      },
    ];
    const result = selectWorkflow(["cursor"], workflows);
    expect(result).toBeNull();
  });

  it("returns null for empty workflows", () => {
    const result = selectWorkflow(["claude"], []);
    expect(result).toBeNull();
  });

  it("breaks ties by name (lexicographic)", () => {
    const workflows = [
      {
        name: "z_workflow",
        providers: ["claude"],
        entrypoint: "test",
      },
      {
        name: "a_workflow",
        providers: ["claude"],
        entrypoint: "test",
      },
    ];
    const result = selectWorkflow(["claude"], workflows);
    expect(result).toBe("a_workflow");
  });
});

describe("normalizeHarnessConfig", () => {
  it("normalizes a real .agent-harness.toml structure", () => {
    const parsed = {
      version: 1,
      agents: {
        planner: {
          provider: "claude",
          mode: "read",
          model: "haiku",
          reasoning: "low",
          timeout_seconds: 600,
          allowed_tools: ["Read", "Glob", "Grep"],
        },
        implementer: {
          provider: "codex",
          mode: "write",
          model: "gpt-5.6-terra",
          reasoning: "high",
          timeout_seconds: 2400,
          unsafe_bypass: true,
        },
        cursor_composer: {
          provider: "cursor",
          mode: "write",
          model: "composer-2.5",
          timeout_seconds: 2400,
          unsafe_bypass: true,
        },
      },
      workflows: {
        evaluated_change: {
          entrypoint: "plan",
          workspace: "worktree",
          base_ref: "HEAD",
          max_steps: 13,
          max_wall_seconds: 9000,
          nodes: {
            plan: {
              kind: "agent",
              agent: "planner",
              on_success: "implement",
              on_failure: "failed",
              prompt: "Plan this task",
            },
            implement: {
              kind: "agent",
              agent: "implementer",
              on_success: "changed",
              on_failure: "failed",
              prompt: "Implement this task",
            },
          },
        },
      },
    };

    const result = normalizeHarnessConfig(parsed);

    expect(result.version).toBe(1);
    expect(result.agents).toHaveLength(3);
    expect(result.agents[0]?.name).toBe("planner");
    expect(result.agents[0]?.provider).toBe("claude");
    expect(result.agents[0]?.mode).toBe("read");
    expect(result.agents[0]?.timeoutSeconds).toBe(600);
    expect(result.agents[0]?.allowedTools).toEqual(["Read", "Glob", "Grep"]);

    expect(result.agents[1]?.name).toBe("implementer");
    expect(result.agents[1]?.unsafeBypass).toBe(true);

    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]?.name).toBe("evaluated_change");
    expect(result.workflows[0]?.providers).toEqual(["claude", "codex"]);
    expect(result.workflows[0]?.entrypoint).toBe("plan");
    expect(result.workflows[0]?.workspace).toBe("worktree");
    expect(result.workflows[0]?.maxSteps).toBe(13);
    expect(result.workflows[0]?.maxWallSeconds).toBe(9000);
    expect(result.workflows[0]?.nodes).toHaveLength(2);
  });

  it("handles optional fields", () => {
    const parsed = {
      agents: {
        simple: {
          provider: "claude",
          mode: "read",
        },
      },
      workflows: {
        simple: {
          nodes: {},
        },
      },
    };

    const result = normalizeHarnessConfig(parsed);

    expect(result.version).toBeUndefined();
    expect(result.agents[0]?.model).toBeUndefined();
    expect(result.agents[0]?.reasoning).toBeUndefined();
    expect(result.agents[0]?.timeoutSeconds).toBeUndefined();
    expect(result.agents[0]?.allowedTools).toBeUndefined();
    expect(result.agents[0]?.unsafeBypass).toBe(false);

    expect(result.workflows[0]?.entrypoint).toBeUndefined();
    expect(result.workflows[0]?.workspace).toBeUndefined();
    expect(result.workflows[0]?.maxSteps).toBeUndefined();
  });

  it("handles fanout nodes with multiple agents", () => {
    const parsed = {
      agents: {
        planner: { provider: "claude", mode: "read" },
        codex_planner: { provider: "codex", mode: "read" },
      },
      workflows: {
        dual: {
          nodes: {
            research: {
              kind: "fanout",
              agents: ["planner", "codex_planner"],
              prompt: "Research this",
            },
          },
        },
      },
    };

    const result = normalizeHarnessConfig(parsed);

    expect(result.workflows[0]?.providers).toEqual(["claude", "codex"]);
    expect(result.workflows[0]?.nodes?.[0]?.agents).toEqual(["planner", "codex_planner"]);
  });

  it("returns empty config for null input", () => {
    const result = normalizeHarnessConfig(null);
    expect(result.agents).toEqual([]);
    expect(result.workflows).toEqual([]);
  });

  it("returns empty config for undefined input", () => {
    const result = normalizeHarnessConfig(undefined);
    expect(result.agents).toEqual([]);
    expect(result.workflows).toEqual([]);
  });

  it("returns empty config for non-object input", () => {
    expect(normalizeHarnessConfig("string").agents).toEqual([]);
    expect(normalizeHarnessConfig(123).agents).toEqual([]);
    expect(normalizeHarnessConfig(true).agents).toEqual([]);
  });

  it("ignores malformed agents", () => {
    const parsed = {
      agents: {
        valid: { provider: "claude", mode: "read" },
        invalid_array: ["not", "an", "object"],
        invalid_string: "not an object",
        invalid_null: null,
      },
      workflows: {},
    };

    const result = normalizeHarnessConfig(parsed);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.name).toBe("valid");
  });

  it("ignores malformed workflows", () => {
    const parsed = {
      agents: { planner: { provider: "claude", mode: "read" } },
      workflows: {
        valid: { nodes: { plan: { kind: "agent", agent: "planner" } } },
        invalid_array: ["not", "an", "object"],
        invalid_string: "not an object",
      },
    };

    const result = normalizeHarnessConfig(parsed);
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]?.name).toBe("valid");
  });

  it("ignores malformed nodes", () => {
    const parsed = {
      agents: { planner: { provider: "claude", mode: "read" } },
      workflows: {
        test: {
          nodes: {
            valid: { kind: "agent", agent: "planner" },
            invalid_string: "not an object",
            invalid_array: ["not", "an", "object"],
          },
        },
      },
    };

    const result = normalizeHarnessConfig(parsed);
    expect(result.workflows[0]?.nodes).toHaveLength(1);
    expect(result.workflows[0]?.nodes?.[0]?.kind).toBe("agent");
  });

  it("coerces non-string/number values to empty/undefined", () => {
    const parsed = {
      agents: {
        test: {
          provider: 123,
          mode: null,
          model: undefined,
          timeout_seconds: "not a number",
        },
      },
      workflows: {},
    };

    const result = normalizeHarnessConfig(parsed);
    expect(result.agents[0]?.provider).toBe("");
    expect(result.agents[0]?.mode).toBe("");
    expect(result.agents[0]?.model).toBeUndefined();
    expect(result.agents[0]?.timeoutSeconds).toBeUndefined();
  });
});

describe("WORKFLOW_CONFIG_NAMES", () => {
  it("exports config file names in preference order", () => {
    expect(WORKFLOW_CONFIG_NAMES[0]).toBe(".agent-harness.toml");
    expect(WORKFLOW_CONFIG_NAMES[1]).toBe("agent-harness.toml");
    expect(WORKFLOW_CONFIG_NAMES[2]).toBe(".agent-harness/config.toml");
    expect(WORKFLOW_CONFIG_NAMES[3]).toBe(".config/agent-harness.toml");
  });
});

describe("globalHarnessConfigCandidates", () => {
  const join = (...segments: readonly string[]) => segments.join("/");

  it("puts an explicit pointer ahead of every convention", () => {
    const candidates = globalHarnessConfigCandidates({
      environment: { [HARNESS_CONFIG_ENV]: "/work/workflows", HOME: "/home/dev" },
      harnessHome: "/home/dev/.local/share/agent-harness",
      join,
    });

    expect(candidates[0]).toBe("/work/workflows");
    // A directory pointer is honoured too, so users need not name the file.
    expect(candidates).toContain("/work/workflows/.agent-harness.toml");
    expect(candidates.indexOf("/work/workflows/.agent-harness.toml")).toBeLessThan(
      candidates.indexOf("/home/dev/.agent-harness.toml"),
    );
  });

  it("searches the harness home, then XDG, then the home directory", () => {
    const candidates = globalHarnessConfigCandidates({
      environment: { HOME: "/home/dev", XDG_CONFIG_HOME: "/home/dev/.xdg" },
      harnessHome: "/state/agent-harness",
      join,
    });

    expect(candidates).toContain("/state/agent-harness/.agent-harness.toml");
    expect(candidates).toContain("/home/dev/.xdg/agent-harness/config.toml");
    expect(candidates).toContain("/home/dev/.config/agent-harness/config.toml");
    expect(candidates.indexOf("/state/agent-harness/.agent-harness.toml")).toBeLessThan(
      candidates.indexOf("/home/dev/.xdg/agent-harness/config.toml"),
    );
  });

  it("emits no duplicates and skips unset roots", () => {
    const candidates = globalHarnessConfigCandidates({
      environment: {},
      harnessHome: "/state/agent-harness",
      join,
    });

    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates.every((path) => path.startsWith("/state/agent-harness"))).toBe(true);
  });

  it("falls back to USERPROFILE when HOME is unset", () => {
    const candidates = globalHarnessConfigCandidates({
      environment: { USERPROFILE: "/users/dev" },
      harnessHome: "/state/agent-harness",
      join,
    });

    expect(candidates).toContain("/users/dev/.agent-harness.toml");
  });
});
