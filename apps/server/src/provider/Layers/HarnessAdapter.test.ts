import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  applyHarnessEvent,
  EMPTY_RUN_PROGRESS,
  type HarnessEvent,
  type HarnessRunProgress,
  parseHarnessEvent,
} from "@t3tools/shared/harnessRun";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";

import {
  applyAgentActivity,
  describeAgentProgress,
  EMPTY_AGENT_PROGRESS,
  type HarnessAgentProgress,
  parseHarnessAgentEvent,
  parseHarnessStepCommand,
} from "@t3tools/shared/harnessStepStream";

import {
  HARNESS_DRIVER_KIND,
  makeStepProgressEvent,
  mapAgentActivityToRuntimeEvents,
  mapHarnessEventToRuntimeEvents,
} from "./HarnessAdapter.ts";

const jsonLine = Schema.fromJsonString(Schema.Unknown);
const encodeJsonLine = Schema.encodeSync(jsonLine);
const decodeJsonLine = Schema.decodeSync(jsonLine);

const THREAD_ID = ThreadId.make("thread-harness-1");
const TURN_ID = TurnId.make("turn-harness-1");
const INSTANCE_ID = ProviderInstanceId.make("harness");
const RUN_ID = "run-2026-08-05-abc";

/**
 * Replay a whole `events.jsonl` the way the adapter's tail loop does: fold
 * each event into the run progress, then map it with the progress that folding
 * produced.
 */
function replay(lines: ReadonlyArray<string>): {
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  readonly progress: HarnessRunProgress;
} {
  let progress = EMPTY_RUN_PROGRESS;
  let turnStarted = false;
  const events: Array<ProviderRuntimeEvent> = [];

  for (const line of lines) {
    const parsed: HarnessEvent | null = parseHarnessEvent(decodeJsonLine(line));
    if (parsed === null) {
      continue;
    }
    progress = applyHarnessEvent(progress, parsed);
    const mapped = mapHarnessEventToRuntimeEvents(
      {
        provider: HARNESS_DRIVER_KIND,
        providerInstanceId: INSTANCE_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        createdAt: "2026-08-05T00:00:00.000Z",
        turnStarted,
        progress,
      },
      parsed,
    );
    for (const event of mapped) {
      if (event.type === "turn.started") {
        turnStarted = true;
      }
      events.push(event);
    }
  }

  return { events, progress };
}

function runStarted(workflow: string): string {
  return encodeJsonLine({
    type: "run.started",
    run_id: RUN_ID,
    workflow,
    repo: "/repos/t3code",
    config: "/repos/t3code/.agent-harness.toml",
    time: "2026-08-05T00:00:00Z",
  });
}

function stepStarted(node: string, step: number): string {
  return encodeJsonLine({
    type: "step.started",
    run_id: RUN_ID,
    node,
    step,
    visit: 1,
    kind: "agent",
    time: "2026-08-05T00:00:01Z",
  });
}

function stepFinished(input: {
  readonly node: string;
  readonly step: number;
  readonly success: boolean;
  readonly agent?: string;
  readonly models?: ReadonlyArray<string>;
  readonly costUsd?: number;
  readonly error?: string;
}): string {
  return encodeJsonLine({
    type: "step.finished",
    run_id: RUN_ID,
    node: input.node,
    step: input.step,
    success: input.success,
    details: {
      agent: input.agent ?? "codex_architect",
      cost_usd: input.costUsd ?? null,
      duration_seconds: 12.5,
      exit_code: input.success ? 0 : 1,
      timed_out: false,
      error: input.error ?? null,
      metadata: { models: input.models ?? ["gpt-5"] },
    },
    time: "2026-08-05T00:00:30Z",
  });
}

function runFinished(input: {
  readonly status: string;
  readonly steps: number;
  readonly workspace: string | null;
}): string {
  return encodeJsonLine({
    type: "run.finished",
    run_id: RUN_ID,
    status: input.status,
    steps: input.steps,
    elapsed_seconds: 91.25,
    workspace: input.workspace,
    time: "2026-08-05T00:01:31Z",
  });
}

const SUCCESSFUL_RUN = [
  runStarted("evaluated_change"),
  stepStarted("plan", 1),
  stepFinished({ node: "plan", step: 1, success: true, agent: "codex_architect", costUsd: 0.12 }),
  stepStarted("implement", 2),
  stepFinished({
    node: "implement",
    step: 2,
    success: true,
    agent: "claude_builder",
    models: ["claude-opus-4"],
    costUsd: 0.5,
  }),
  stepStarted("review", 3),
  stepFinished({ node: "review", step: 3, success: true, agent: "codex_reviewer", costUsd: 0.08 }),
  runFinished({ status: "done", steps: 3, workspace: "/repos/.worktrees/run-abc" }),
];

describe("mapHarnessEventToRuntimeEvents", () => {
  effectIt("maps a three-step run to a full turn of runtime events", () =>
    Effect.sync(() => {
      const { events } = replay(SUCCESSFUL_RUN);

      expect(events.map((event) => event.type)).toEqual([
        "turn.started",
        "item.completed",
        "item.started",
        "item.completed",
        "thread.token-usage.updated",
        "item.started",
        "item.completed",
        "thread.token-usage.updated",
        "item.started",
        "item.completed",
        "thread.token-usage.updated",
        "item.completed",
        "turn.completed",
      ]);

      // The turn opens once, named after the workflow.
      const started = events[0]!;
      expect(started.type === "turn.started" && started.payload.model).toBe("evaluated_change");
      expect(started.turnId).toBe(TURN_ID);
      expect(started.provider).toBe(ProviderDriverKind.make("harness"));
      expect(started.providerInstanceId).toBe(INSTANCE_ID);

      // Each step is one tool-like item, opened and closed against one id.
      const stepItems = events.filter(
        (event) =>
          (event.type === "item.started" || event.type === "item.completed") &&
          event.payload.itemType === "dynamic_tool_call",
      );
      expect(stepItems.map((event) => event.itemId)).toEqual([
        `harness:${RUN_ID}:step:1`,
        `harness:${RUN_ID}:step:1`,
        `harness:${RUN_ID}:step:2`,
        `harness:${RUN_ID}:step:2`,
        `harness:${RUN_ID}:step:3`,
        `harness:${RUN_ID}:step:3`,
      ]);
      const implementCompleted = events.find(
        (event) =>
          event.type === "item.completed" &&
          event.payload.itemType === "dynamic_tool_call" &&
          event.payload.title === "implement",
      );
      expect(
        implementCompleted?.type === "item.completed" && implementCompleted.payload.status,
      ).toBe("completed");
      expect(
        implementCompleted?.type === "item.completed" && implementCompleted.payload.detail,
      ).toContain("claude_builder");
      expect(
        implementCompleted?.type === "item.completed" && implementCompleted.payload.detail,
      ).toContain("claude-opus-4");

      // Cost is reported per step even though tokens never are.
      const usage = events.filter((event) => event.type === "thread.token-usage.updated");
      expect(usage).toHaveLength(3);
      expect(
        usage[0]?.type === "thread.token-usage.updated" && usage[0].payload.usage.usedTokens,
      ).toBe(0);
      expect(
        usage[0]?.type === "thread.token-usage.updated" && usage[0].payload.usage.durationMs,
      ).toBe(12_500);

      const completed = events.at(-1)!;
      expect(completed.type === "turn.completed" && completed.payload.state).toBe("completed");
      expect(completed.type === "turn.completed" && completed.payload.totalCostUsd).toBeCloseTo(
        0.7,
        5,
      );
    }),
  );

  effectIt("carries the workspace path into the closing assistant item", () =>
    Effect.sync(() => {
      const { events } = replay(SUCCESSFUL_RUN);
      const summary = events.at(-2)!;

      expect(summary.type).toBe("item.completed");
      expect(summary.type === "item.completed" && summary.payload.itemType).toBe(
        "assistant_message",
      );
      const detail = summary.type === "item.completed" ? (summary.payload.detail ?? "") : "";
      expect(detail).toContain("/repos/.worktrees/run-abc");
      expect(detail).toContain("3 steps");
      expect(detail).toContain("91.2s");
      expect(summary.itemId).toBe(`harness:${RUN_ID}:summary`);
    }),
  );

  effectIt("surfaces a failed step's error and fails the turn", () =>
    Effect.sync(() => {
      const { events } = replay([
        runStarted("evaluated_change"),
        stepStarted("plan", 1),
        stepFinished({ node: "plan", step: 1, success: true, costUsd: 0.1 }),
        stepStarted("implement", 2),
        stepFinished({
          node: "implement",
          step: 2,
          success: false,
          agent: "claude_builder",
          error: "pytest exited with 1: 3 tests failed",
        }),
        runFinished({ status: "failed", steps: 2, workspace: "/repos/.worktrees/run-abc" }),
      ]);

      const failedItem = events.find(
        (event) => event.type === "item.completed" && event.payload.title === "implement",
      );
      expect(failedItem?.type === "item.completed" && failedItem.payload.status).toBe("failed");
      expect(failedItem?.type === "item.completed" && failedItem.payload.detail).toContain(
        "pytest exited with 1: 3 tests failed",
      );

      const completed = events.at(-1)!;
      expect(completed.type === "turn.completed" && completed.payload.state).toBe("failed");
      expect(completed.type === "turn.completed" && completed.payload.stopReason).toBe("failed");
      expect(completed.type === "turn.completed" && completed.payload.errorMessage).toContain(
        "pytest exited with 1",
      );

      // The failure is also visible in the summary the user reads last.
      const summary = events.at(-2)!;
      expect(summary.type === "item.completed" && summary.payload.detail).toContain(
        "Failed at implement",
      );
    }),
  );

  effectIt("does not reopen a turn that is already running", () =>
    Effect.sync(() => {
      const parsed = parseHarnessEvent(decodeJsonLine(runStarted("vibe_code")));
      const mapped = mapHarnessEventToRuntimeEvents(
        {
          provider: HARNESS_DRIVER_KIND,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          createdAt: "2026-08-05T00:00:00.000Z",
          turnStarted: true,
          progress: EMPTY_RUN_PROGRESS,
        },
        parsed!,
      );

      expect(mapped.map((event) => event.type)).toEqual(["item.completed"]);
      expect(mapped[0]?.type === "item.completed" && mapped[0].payload.detail).toContain(
        "vibe_code",
      );
      expect(mapped[0]?.providerInstanceId).toBeUndefined();
    }),
  );
});

/**
 * Replay a step's own `events.jsonl` the way `tailStep` does: recover the tool
 * name a Claude result omits, map, then fold.
 */
function replayStep(lines: ReadonlyArray<unknown>): {
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  readonly progress: HarnessAgentProgress;
} {
  const toolNames = new Map<string, { name: string; detail: string | null }>();
  const events: Array<ProviderRuntimeEvent> = [];
  let progress = EMPTY_AGENT_PROGRESS;
  let sequence = 0;

  for (const line of lines) {
    for (const raw of parseHarnessAgentEvent(line)) {
      const remembered =
        raw.kind === "tool" && raw.name.length === 0 ? toolNames.get(raw.id) : undefined;
      const activity =
        raw.kind === "tool" && remembered !== undefined
          ? { ...raw, name: remembered.name, detail: raw.detail ?? remembered.detail }
          : raw;
      events.push(
        ...mapAgentActivityToRuntimeEvents(
          {
            provider: HARNESS_DRIVER_KIND,
            providerInstanceId: INSTANCE_ID,
            threadId: THREAD_ID,
            turnId: TURN_ID,
            createdAt: "2026-08-05T00:00:05.000Z",
            runId: RUN_ID,
            step: 2,
            node: "implement",
            sequence: (sequence += 1),
          },
          activity,
        ),
      );
      progress = applyAgentActivity(progress, activity, toolNames);
    }
  }

  return { events, progress };
}

describe("mapAgentActivityToRuntimeEvents", () => {
  effectIt("turns a Claude step into messages and tool items on the thread", () =>
    Effect.sync(() => {
      const { events, progress } = replayStep([
        {
          type: "system",
          subtype: "init",
          model: "claude-haiku-4-5-20251001",
          session_id: "session-1",
          tools: ["Read", "Bash"],
        },
        {
          type: "assistant",
          message: {
            id: "msg_1",
            content: [
              { type: "thinking", thinking: "Where does the router live?" },
              { type: "text", text: "Reading the router first." },
              {
                type: "tool_use",
                id: "toolu_1",
                name: "Bash",
                input: { command: "vp run -r typecheck" },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
          },
        },
      ]);

      // Thinking is folded into the node's one-liner, not into the thread.
      expect(events.map((event) => event.type)).toEqual([
        "item.completed",
        "item.started",
        "item.completed",
      ]);

      const message = events[0]!;
      expect(message.type === "item.completed" && message.payload.itemType).toBe(
        "assistant_message",
      );
      expect(message.type === "item.completed" && message.payload.detail).toBe(
        "Reading the router first.",
      );

      // One tool, one item id, opened and closed — and the name survives the
      // result, which carries only the id.
      const [, opened, closed] = events;
      expect(opened?.itemId).toBe(`harness:${RUN_ID}:step:2:tool:toolu_1`);
      expect(closed?.itemId).toBe(opened?.itemId);
      expect(opened?.type === "item.started" && opened.payload.itemType).toBe("command_execution");
      expect(opened?.type === "item.started" && opened.payload.title).toBe("Bash");
      expect(closed?.type === "item.completed" && closed.payload.title).toBe("Bash");
      expect(closed?.type === "item.completed" && closed.payload.status).toBe("completed");

      expect(progress.model).toBe("claude-haiku-4-5-20251001");
      expect(progress.toolCalls).toBe(1);
      expect(progress.activeTool).toBeNull();
    }),
  );

  effectIt("gives every emitted event its own id", () =>
    Effect.sync(() => {
      const { events } = replayStep([
        {
          type: "assistant",
          message: {
            id: "msg_1",
            content: [
              { type: "text", text: "one" },
              { type: "text", text: "two" },
            ],
          },
        },
      ]);
      const ids = events.map((event) => event.eventId);
      expect(new Set(ids).size).toBe(ids.length);
      const itemIds = events.map((event) => event.itemId);
      expect(new Set(itemIds).size).toBe(itemIds.length);
    }),
  );

  effectIt("reports an agent's mid-step failure as a warning, not a turn failure", () =>
    Effect.sync(() => {
      const { events } = replayStep([{ type: "error", message: "You've hit your usage limit." }]);
      expect(events).toHaveLength(1);
      const warning = events[0]!;
      expect(warning.type).toBe("runtime.warning");
      expect(warning.type === "runtime.warning" && warning.payload.message).toBe(
        "implement: You've hit your usage limit.",
      );
    }),
  );

  effectIt("keeps a Codex command's outcome on one item", () =>
    Effect.sync(() => {
      const item = {
        id: "item_1",
        type: "command_execution",
        command: "vp lint",
        exit_code: 1,
        status: "completed",
      };
      const { events } = replayStep([
        { type: "item.started", item: { ...item, exit_code: null, status: "in_progress" } },
        { type: "item.completed", item },
      ]);
      expect(events.map((event) => event.itemId)).toEqual([
        `harness:${RUN_ID}:step:2:tool:item_1`,
        `harness:${RUN_ID}:step:2:tool:item_1`,
      ]);
      expect(events[1]?.type === "item.completed" && events[1].payload.status).toBe("failed");
    }),
  );
});

describe("makeStepProgressEvent", () => {
  effectIt("updates the node's own item with who is working and on what", () =>
    Effect.sync(() => {
      const command = parseHarnessStepCommand({
        provider: "claude",
        agent: "claude_lead",
        model: "sonnet",
        mode: "write",
        argv: ["claude", "-p"],
        cwd: "/worktrees/run-abc",
      });
      const progress: HarnessAgentProgress = {
        ...EMPTY_AGENT_PROGRESS,
        model: "claude-sonnet-4-5",
        activeTool: { name: "Edit", detail: "src/router.ts" },
        toolCalls: 7,
      };
      const event = makeStepProgressEvent(
        {
          provider: HARNESS_DRIVER_KIND,
          providerInstanceId: INSTANCE_ID,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          createdAt: "2026-08-05T00:00:05.000Z",
          runId: RUN_ID,
          step: 2,
          node: "implement",
          sequence: 4,
        },
        { detail: describeAgentProgress({ command, progress }), command, progress },
      );

      // The same item the run-level tail opened for this node, so the row
      // updates in place rather than stacking up.
      expect(event.itemId).toBe(`harness:${RUN_ID}:step:2`);
      expect(event.type).toBe("item.updated");
      expect(event.type === "item.updated" && event.payload.status).toBe("inProgress");
      expect(event.type === "item.updated" && event.payload.detail).toBe(
        "claude_lead · claude-sonnet-4-5 · Edit: src/router.ts · 7 tools",
      );
      expect(event.type === "item.updated" && event.payload.data).toMatchObject({
        node: "implement",
        step: 2,
        provider: "claude",
        agent: "claude_lead",
        model: "claude-sonnet-4-5",
        mode: "write",
        toolCalls: 7,
        activeTool: "Edit",
      });
    }),
  );
});
