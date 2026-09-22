import { describe, expect, it } from "vite-plus/test";

import {
  applyAgentActivity,
  describeAgentProgress,
  describeCommandOutput,
  claudeProjectDirName,
  claudeSessionIdFromArgv,
  EMPTY_AGENT_PROGRESS,
  harnessStepDirName,
  harnessStepTranscriptSegments,
  type HarnessAgentProgress,
  type HarnessStepCommand,
  parseHarnessAgentEvent,
  parseHarnessStepCommand,
} from "./harnessStepStream.ts";

// Every fixture below is copied from a real step directory, not invented.

const CLAUDE_INIT = {
  type: "system",
  subtype: "init",
  cwd: "/worktrees/gear-mind-20260804",
  session_id: "61498899-36e9-45c9-8cc8-93ba4d2ee93c",
  tools: ["Glob", "Grep", "Read"],
  mcp_servers: [],
  model: "claude-haiku-4-5-20251001",
  permissionMode: "dontAsk",
};

const CLAUDE_ASSISTANT = {
  type: "assistant",
  message: {
    model: "claude-haiku-4-5-20251001",
    id: "msg_011CdhBFFYk5pNu8Qc6Z2yvi",
    type: "message",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "The user wants me to plan a task without editing." },
      { type: "text", text: "I'll read AGENTS.md first." },
      {
        type: "tool_use",
        id: "toolu_01NqH8GDcQKiKCSQw35S1tZE",
        name: "Read",
        input: { file_path: "/worktrees/gear-mind-20260804/AGENTS.md" },
      },
    ],
  },
};

const CLAUDE_TOOL_RESULT = {
  type: "user",
  message: {
    role: "user",
    content: [
      {
        tool_use_id: "toolu_01NqH8GDcQKiKCSQw35S1tZE",
        type: "tool_result",
        content: "1\t## graphify\n",
      },
    ],
  },
};

const CLAUDE_RESULT = {
  type: "result",
  is_error: false,
  duration_api_ms: 101653,
  num_turns: 37,
  session_id: "61498899-36e9-45c9-8cc8-93ba4d2ee93c",
  total_cost_usd: 0.2975042,
  usage: {
    input_tokens: 381,
    cache_creation_input_tokens: 75984,
    cache_read_input_tokens: 1111252,
    output_tokens: 6660,
  },
};

const CODEX_COMMAND_STARTED = {
  type: "item.started",
  item: {
    id: "item_1",
    type: "command_execution",
    command: "/bin/zsh -lc \"sed -n '1,240p' CLAUDE.md\"",
    aggregated_output: "",
    exit_code: null,
    status: "in_progress",
  },
};

const CODEX_COMMAND_FINISHED = {
  type: "item.completed",
  item: {
    id: "item_1",
    type: "command_execution",
    command: "/bin/zsh -lc \"sed -n '1,240p' CLAUDE.md\"",
    exit_code: 0,
    status: "completed",
  },
};

describe("harnessStepDirName", () => {
  it("pads the step number the way the harness does", () => {
    expect(harnessStepDirName(1, "plan")).toBe("01-plan");
    expect(harnessStepDirName(13, "repair")).toBe("13-repair");
  });
});

describe("parseHarnessStepCommand", () => {
  it("reads the role and model an agent node is about to run", () => {
    const command = parseHarnessStepCommand({
      provider: "codex",
      agent: "codex_architect",
      model: "gpt-5.6-sol",
      mode: "read",
      reasoning: "xhigh",
      argv: ["codex", "exec", "--json"],
      cwd: "/worktrees/x",
    });
    expect(command).toMatchObject({
      provider: "codex",
      agent: "codex_architect",
      model: "gpt-5.6-sol",
      mode: "read",
    });
  });

  it("accepts a shell command node, which names no provider", () => {
    const command = parseHarnessStepCommand({
      argv: ["python3", "-m", "unittest"],
      cwd: "/worktrees/x",
    });
    expect(command).toMatchObject({ provider: null, agent: null, model: null });
    expect(command?.argv).toEqual(["python3", "-m", "unittest"]);
  });

  it("rejects a line that is not an object", () => {
    expect(parseHarnessStepCommand("nope")).toBeNull();
  });
});

describe("parseHarnessAgentEvent", () => {
  it("reads the model and tools off a Claude init line", () => {
    expect(parseHarnessAgentEvent(CLAUDE_INIT)).toEqual([
      {
        kind: "session",
        model: "claude-haiku-4-5-20251001",
        sessionId: "61498899-36e9-45c9-8cc8-93ba4d2ee93c",
        tools: ["Glob", "Grep", "Read"],
      },
    ]);
  });

  it("splits one assistant message into its thinking, prose, and tool call", () => {
    const activities = parseHarnessAgentEvent(CLAUDE_ASSISTANT);
    expect(activities.map((activity) => activity.kind)).toEqual(["reasoning", "message", "tool"]);
    expect(activities[2]).toEqual({
      kind: "tool",
      id: "toolu_01NqH8GDcQKiKCSQw35S1tZE",
      name: "Read",
      itemKind: "dynamic_tool_call",
      status: "started",
      detail: "/worktrees/gear-mind-20260804/AGENTS.md",
    });
  });

  it("classifies Claude tools by what they do", () => {
    const kindOf = (name: string, input: unknown) =>
      parseHarnessAgentEvent({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name, input }] },
      })[0];
    expect(kindOf("Bash", { command: "git status" })).toMatchObject({
      itemKind: "command_execution",
      detail: "git status",
    });
    expect(kindOf("Edit", { file_path: "/a/b.ts" })).toMatchObject({ itemKind: "file_change" });
    expect(kindOf("WebSearch", { query: "effect ts" })).toMatchObject({ itemKind: "web_search" });
    expect(kindOf("mcp__slack__send", {})).toMatchObject({ itemKind: "mcp_tool_call" });
  });

  it("closes a Claude tool call from its result, which carries only the id", () => {
    expect(parseHarnessAgentEvent(CLAUDE_TOOL_RESULT)).toEqual([
      {
        kind: "tool",
        id: "toolu_01NqH8GDcQKiKCSQw35S1tZE",
        name: "",
        itemKind: "dynamic_tool_call",
        status: "completed",
        detail: null,
      },
    ]);
  });

  it("marks an errored tool result as failed", () => {
    const [activity] = parseHarnessAgentEvent({
      type: "user",
      message: {
        role: "user",
        content: [{ tool_use_id: "t1", type: "tool_result", is_error: true, content: "boom" }],
      },
    });
    expect(activity).toMatchObject({ status: "failed" });
  });

  it("reads tokens and cost off a Claude result line", () => {
    expect(parseHarnessAgentEvent(CLAUDE_RESULT)).toEqual([
      {
        kind: "usage",
        inputTokens: 381,
        outputTokens: 6660,
        cachedInputTokens: 1111252,
        costUsd: 0.2975042,
      },
    ]);
  });

  it("carries the provider's sentence out of a usage-limited result line", () => {
    // Copied from a step that died when a subscription window closed: the CLI
    // reports `subtype: "success"` and still means it failed.
    expect(
      parseHarnessAgentEvent({
        type: "result",
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 429,
        result: "You've hit your session limit · resets 3:40pm (America/Indianapolis)",
        total_cost_usd: 0.775,
        usage: { input_tokens: 58, output_tokens: 9561, cache_read_input_tokens: 1149781 },
      }),
    ).toEqual([
      {
        kind: "usage",
        inputTokens: 58,
        outputTokens: 9561,
        cachedInputTokens: 1149781,
        costUsd: 0.775,
      },
      {
        kind: "error",
        message: "HTTP 429: You've hit your session limit · resets 3:40pm (America/Indianapolis)",
      },
    ]);
  });

  it("names the status when a failed result line says nothing else", () => {
    expect(
      parseHarnessAgentEvent({ type: "result", is_error: true, api_error_status: 529 }),
    ).toEqual([
      {
        kind: "usage",
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        costUsd: null,
      },
      { kind: "error", message: "HTTP 529" },
    ]);
  });

  it("reports a non-success subtype as a failure", () => {
    expect(parseHarnessAgentEvent({ type: "result", subtype: "error_max_turns" }).at(-1)).toEqual({
      kind: "error",
      message: "The agent failed (error_max_turns).",
    });
  });

  it("leaves a successful result line as usage alone", () => {
    expect(parseHarnessAgentEvent(CLAUDE_RESULT)).toHaveLength(1);
  });

  it("tracks a Codex command through its item lifecycle", () => {
    expect(parseHarnessAgentEvent(CODEX_COMMAND_STARTED)).toEqual([
      {
        kind: "tool",
        id: "item_1",
        name: "command_execution",
        itemKind: "command_execution",
        status: "started",
        detail: "/bin/zsh -lc \"sed -n '1,240p' CLAUDE.md\"",
      },
    ]);
    expect(parseHarnessAgentEvent(CODEX_COMMAND_FINISHED)[0]).toMatchObject({
      status: "completed",
    });
  });

  it("treats a non-zero exit as a failed tool call", () => {
    const [activity] = parseHarnessAgentEvent({
      type: "item.completed",
      item: { id: "item_2", type: "command_execution", command: "vp lint", exit_code: 1 },
    });
    expect(activity).toMatchObject({ status: "failed" });
  });

  it("names the files a Codex file_change touches", () => {
    const [activity] = parseHarnessAgentEvent({
      type: "item.completed",
      item: {
        id: "item_16",
        type: "file_change",
        changes: [{ path: "/worktrees/x/schemas/routes.json", kind: "add" }],
        status: "completed",
      },
    });
    expect(activity).toMatchObject({
      itemKind: "file_change",
      detail: "add /worktrees/x/schemas/routes.json",
    });
  });

  it("keeps only completed Codex agent messages", () => {
    const item = { id: "item_0", type: "agent_message", text: "I'm mapping the repo." };
    expect(parseHarnessAgentEvent({ type: "item.started", item })).toEqual([]);
    expect(parseHarnessAgentEvent({ type: "item.completed", item })).toEqual([
      { kind: "message", id: "item_0", text: "I'm mapping the repo." },
    ]);
  });

  it("reads a Codex todo list", () => {
    const [activity] = parseHarnessAgentEvent({
      type: "item.updated",
      item: {
        id: "item_5",
        type: "todo_list",
        items: [
          { text: "Inspect provider APIs", completed: true },
          { text: "Add focused tests", completed: false },
        ],
      },
    });
    expect(activity).toEqual({
      kind: "todos",
      items: [
        { text: "Inspect provider APIs", completed: true },
        { text: "Add focused tests", completed: false },
      ],
    });
  });

  it("surfaces the failure when an agent hits its usage limit", () => {
    expect(
      parseHarnessAgentEvent({
        type: "error",
        message: "You've hit your usage limit.",
      }),
    ).toEqual([{ kind: "error", message: "You've hit your usage limit." }]);
    expect(
      parseHarnessAgentEvent({
        type: "turn.failed",
        error: { message: "You've hit your usage limit." },
      }),
    ).toEqual([{ kind: "error", message: "You've hit your usage limit." }]);
  });

  it("ignores lines it does not model instead of failing", () => {
    expect(parseHarnessAgentEvent("Reading additional input from stdin...")).toEqual([]);
    expect(parseHarnessAgentEvent({ type: "rate_limit_event" })).toEqual([]);
    expect(parseHarnessAgentEvent({ type: "turn.started" })).toEqual([]);
    expect(parseHarnessAgentEvent({ type: "something.new", item: {} })).toEqual([]);
  });
});

describe("applyAgentActivity", () => {
  const fold = (lines: ReadonlyArray<unknown>): HarnessAgentProgress => {
    const toolNames = new Map<string, { name: string; detail: string | null }>();
    let progress = EMPTY_AGENT_PROGRESS;
    for (const line of lines) {
      for (const activity of parseHarnessAgentEvent(line)) {
        progress = applyAgentActivity(progress, activity, toolNames);
      }
    }
    return progress;
  };

  it("holds the tool in flight, then clears it when the result lands", () => {
    const running = fold([CLAUDE_INIT, CLAUDE_ASSISTANT]);
    expect(running.activeTool).toEqual({
      name: "Read",
      detail: "/worktrees/gear-mind-20260804/AGENTS.md",
    });
    expect(running.toolCalls).toBe(1);
    expect(running.model).toBe("claude-haiku-4-5-20251001");

    const settled = fold([CLAUDE_INIT, CLAUDE_ASSISTANT, CLAUDE_TOOL_RESULT]);
    expect(settled.activeTool).toBeNull();
    expect(settled.toolCalls).toBe(1);
  });

  it("counts a Codex item that only ever reports completion", () => {
    expect(fold([CODEX_COMMAND_FINISHED]).toolCalls).toBe(1);
  });

  it("does not double-count a Codex item that reports both ends", () => {
    expect(fold([CODEX_COMMAND_STARTED, CODEX_COMMAND_FINISHED]).toolCalls).toBe(1);
  });

  it("accumulates messages, usage, and errors", () => {
    const progress = fold([
      CLAUDE_ASSISTANT,
      CLAUDE_RESULT,
      { type: "error", message: "rate limited" },
    ]);
    expect(progress.messages).toBe(1);
    expect(progress.lastMessage).toBe("I'll read AGENTS.md first.");
    expect(progress.outputTokens).toBe(6660);
    expect(progress.costUsd).toBeCloseTo(0.2975042);
    expect(progress.errors).toEqual(["rate limited"]);
  });
});

describe("describeAgentProgress", () => {
  const command = parseHarnessStepCommand({
    provider: "claude",
    agent: "claude_lead",
    model: "sonnet",
    mode: "write",
    argv: [],
  });

  it("leads with the tool in flight — the answer to 'is it stuck?'", () => {
    const line = describeAgentProgress({
      command,
      progress: {
        ...EMPTY_AGENT_PROGRESS,
        model: "claude-haiku-4-5-20251001",
        activeTool: { name: "Bash", detail: "vp run -r test" },
        toolCalls: 12,
        outputTokens: 6660,
      },
    });
    expect(line).toBe(
      "claude_lead · claude-haiku-4-5-20251001 · Bash: vp run -r test · 12 tools · 6.7k out",
    );
  });

  it("falls back to the last message when no tool is running", () => {
    const line = describeAgentProgress({
      command,
      progress: { ...EMPTY_AGENT_PROGRESS, lastMessage: "Reading the plan." },
    });
    expect(line).toBe("claude_lead · sonnet · Reading the plan.");
  });

  it("reports todo completion when the agent keeps a list", () => {
    const line = describeAgentProgress({
      command: null,
      progress: {
        ...EMPTY_AGENT_PROGRESS,
        todos: [
          { text: "a", completed: true },
          { text: "b", completed: false },
        ],
      },
    });
    expect(line).toBe("1/2 todo");
  });

  it("says something before the agent has said anything", () => {
    expect(describeAgentProgress({ command: null, progress: EMPTY_AGENT_PROGRESS })).toBe(
      "starting…",
    );
  });
});

describe("describeCommandOutput", () => {
  it("keeps the last non-empty lines of a shell node's output", () => {
    expect(describeCommandOutput("a\n\nb\nc\nd\n", 2)).toBe("c\nd");
  });

  it("returns null when nothing has been written yet", () => {
    expect(describeCommandOutput("\n\n")).toBeNull();
  });
});

describe("harnessStepTranscriptSegments", () => {
  // Taken from a real `command.json`: the harness pins a fresh session per step.
  const claudeCommand: HarnessStepCommand = {
    provider: "claude",
    agent: "claude_architect",
    model: "opus",
    mode: "read",
    reasoning: "high",
    cwd: "/Users/p/.local/share/agent-harness/worktrees/gear-mind-20260806-232747-d8a7dde4",
    argv: [
      "claude",
      "-p",
      "--session-id",
      "e2aad58a-0d3b-4bf7-821b-daab280315d2",
      "--model",
      "opus",
    ],
  };

  it("locates the transcript the CLI is writing for this step", () => {
    expect(harnessStepTranscriptSegments(claudeCommand)).toEqual([
      "-Users-p--local-share-agent-harness-worktrees-gear-mind-20260806-232747-d8a7dde4",
      "e2aad58a-0d3b-4bf7-821b-daab280315d2.jsonl",
    ]);
  });

  it("accepts the joined spelling of the flag", () => {
    const segments = harnessStepTranscriptSegments({
      ...claudeCommand,
      argv: ["claude", "-p", "--session-id=abc-123"],
    });
    expect(segments?.[1]).toBe("abc-123.jsonl");
  });

  it("has nothing to offer a shell node", () => {
    expect(
      harnessStepTranscriptSegments({
        ...claudeCommand,
        provider: null,
        agent: null,
        argv: ["pnpm", "test"],
      }),
    ).toBeNull();
  });

  it("has nothing to offer another provider, whose state lives elsewhere", () => {
    expect(harnessStepTranscriptSegments({ ...claudeCommand, provider: "codex" })).toBeNull();
  });

  it("gives up rather than guess when the argv pins no session", () => {
    expect(harnessStepTranscriptSegments({ ...claudeCommand, argv: ["claude", "-p"] })).toBeNull();
    expect(
      harnessStepTranscriptSegments({ ...claudeCommand, argv: ["claude", "--session-id"] }),
    ).toBeNull();
  });

  it("has nothing to offer before command.json has been read", () => {
    expect(harnessStepTranscriptSegments(null)).toBeNull();
  });
});

describe("claudeProjectDirName", () => {
  it("replaces every non-alphanumeric character with a dash", () => {
    expect(claudeProjectDirName("/Users/p/Repos/my_app.v2")).toBe("-Users-p-Repos-my-app-v2");
  });
});

describe("claudeSessionIdFromArgv", () => {
  it("returns null when the flag is absent", () => {
    expect(claudeSessionIdFromArgv(["claude", "-p", "--model", "opus"])).toBeNull();
  });
});
