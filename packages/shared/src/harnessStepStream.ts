/**
 * What one harness *step* is doing while it is still running.
 *
 * `harnessRun.ts` models the run-level ledger — which node started, which node
 * finished. That ledger is coarse: a single `implement` node can hold one agent
 * for twenty minutes and report nothing until it is over, which is why a run in
 * flight looks stalled.
 *
 * The detail is on disk the whole time. Each step gets its own directory under
 * `<run dir>/steps/<NN>-<node>/`:
 *
 *   command.json   — provider, role, model, and argv, written before the spawn
 *   events.jsonl   — the agent CLI's own JSON stream
 *   output.txt     — a shell node's combined output, appended live
 *   result.json    — the outcome, written once at the end
 *
 * `events.jsonl` is not appended live: the harness collects the agent's stdout
 * in a temporary file and writes it only once the node exits, so for the twenty
 * minutes that matter there is nothing there to read. A Claude node is watched
 * through the CLI's own transcript instead, which *is* written as it goes —
 * `harnessStepTranscriptSegments` locates it from `command.json` alone.
 *
 * `events.jsonl` is the agent's raw stream, so its shape is the *agent's*, not
 * the harness's: Claude and Cursor both emit Claude's `stream-json`, Codex emits
 * its own `item.*` envelope. Both are normalised here into one
 * `HarnessAgentActivity` union so the adapter has a single thing to render.
 *
 * Everything here is pure. Finding the files and tailing them is the server's
 * job.
 *
 * @module harnessStepStream
 */

/** How the harness names a step's directory: `01-plan`, `13-repair`. */
export function harnessStepDirName(step: number, node: string): string {
  return `${String(Math.trunc(step)).padStart(2, "0")}-${node}`;
}

/**
 * `command.json` — what is about to run, written *before* the agent is spawned.
 *
 * This is the only place the role and model are knowable while the step is in
 * flight; the run-level `step.finished` event reports them far too late to be
 * useful for watching.
 */
export interface HarnessStepCommand {
  /** "claude", "codex", "cursor", or null for a shell command node. */
  readonly provider: string | null;
  /** The workflow role, e.g. `claude_lead`. Null for a shell command node. */
  readonly agent: string | null;
  readonly model: string | null;
  /** "read" or "write" — whether this role was allowed to edit. */
  readonly mode: string | null;
  readonly reasoning: string | null;
  readonly cwd: string | null;
  readonly argv: ReadonlyArray<string>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function parseHarnessStepCommand(value: unknown): HarnessStepCommand | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  return {
    provider: str(record.provider),
    agent: str(record.agent),
    model: str(record.model),
    mode: str(record.mode),
    reasoning: str(record.reasoning),
    cwd: str(record.cwd),
    argv: strings(record.argv),
  };
}

/**
 * The Claude CLI names a project directory after the working directory it was
 * launched in, with every character that is not alphanumeric replaced by a
 * dash — `/Users/x/.local/share` becomes `-Users-x--local-share`.
 */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * The session id the harness pinned for a step, or null when the argv does not
 * carry one. Both spellings the CLI accepts are recognised.
 */
export function claudeSessionIdFromArgv(argv: ReadonlyArray<string>): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--session-id") {
      return str(argv[index + 1]);
    }
    if (arg.startsWith("--session-id=")) {
      return str(arg.slice("--session-id=".length));
    }
  }
  return null;
}

/**
 * Where the Claude CLI is writing this step's transcript, relative to its
 * `projects` directory — or null when the step is not one that has one.
 *
 * The harness pins a fresh `--session-id` per step, so the transcript holds
 * that node's work and nothing else, and it is appended as the agent goes
 * rather than at the end. Joining the segments is the caller's job so this
 * stays free of a path module.
 *
 * Only Claude nodes qualify: a shell node has no agent, and the other
 * providers keep their own state elsewhere in their own shapes.
 */
export function harnessStepTranscriptSegments(
  command: HarnessStepCommand | null,
): readonly [string, string] | null {
  if (command === null || command.provider !== "claude" || command.cwd === null) {
    return null;
  }
  const sessionId = claudeSessionIdFromArgv(command.argv);
  return sessionId === null ? null : [claudeProjectDirName(command.cwd), `${sessionId}.jsonl`];
}

/**
 * How a tool call should be rendered. Mirrors the canonical item types the
 * thread UI already knows how to draw, kept as plain strings so this module
 * stays free of the contracts package.
 */
export type HarnessToolItemKind =
  | "command_execution"
  | "file_change"
  | "web_search"
  | "mcp_tool_call"
  | "dynamic_tool_call";

export type HarnessAgentActivity =
  /** The agent announced itself: model, session, and the tools it may use. */
  | {
      readonly kind: "session";
      readonly model: string | null;
      readonly sessionId: string | null;
      readonly tools: ReadonlyArray<string>;
    }
  /** A completed assistant message. */
  | { readonly kind: "message"; readonly id: string | null; readonly text: string }
  /** A thinking block. */
  | { readonly kind: "reasoning"; readonly text: string }
  /** A tool call beginning, ending, or failing. */
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly name: string;
      readonly itemKind: HarnessToolItemKind;
      readonly status: "started" | "completed" | "failed";
      readonly detail: string | null;
    }
  /** The agent's own checklist. */
  | {
      readonly kind: "todos";
      readonly items: ReadonlyArray<{ readonly text: string; readonly completed: boolean }>;
    }
  /** Tokens and cost, reported once per turn. */
  | {
      readonly kind: "usage";
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      readonly cachedInputTokens: number | null;
      readonly costUsd: number | null;
    }
  | { readonly kind: "error"; readonly message: string };

const CLAUDE_FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const CLAUDE_SEARCH_TOOLS = new Set(["WebSearch", "WebFetch"]);

function claudeToolKind(name: string): HarnessToolItemKind {
  if (name === "Bash" || name === "BashOutput" || name === "KillShell") {
    return "command_execution";
  }
  if (CLAUDE_FILE_TOOLS.has(name)) {
    return "file_change";
  }
  if (CLAUDE_SEARCH_TOOLS.has(name)) {
    return "web_search";
  }
  if (name.startsWith("mcp__")) {
    return "mcp_tool_call";
  }
  return "dynamic_tool_call";
}

/** The one field of a tool's input worth putting on a single line. */
function claudeToolDetail(input: unknown): string | null {
  const record = asRecord(input);
  if (record === null) {
    return null;
  }
  const candidate =
    str(record.command) ??
    str(record.file_path) ??
    str(record.path) ??
    str(record.pattern) ??
    str(record.query) ??
    str(record.description) ??
    str(record.prompt);
  return candidate === null ? null : collapse(candidate);
}

/** One line, bounded — these land in a list row, not a document. */
function collapse(text: string, limit = 200): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`;
}

function codexToolKind(itemType: string): HarnessToolItemKind | null {
  switch (itemType) {
    case "command_execution":
      return "command_execution";
    case "file_change":
      return "file_change";
    case "web_search":
      return "web_search";
    case "mcp_tool_call":
      return "mcp_tool_call";
    case "collab_tool_call":
      return "dynamic_tool_call";
    default:
      return null;
  }
}

function codexToolDetail(item: Record<string, unknown>): string | null {
  const command = str(item.command);
  if (command !== null) {
    return collapse(command);
  }
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const paths = changes
    .map((change) => {
      const record = asRecord(change);
      const path = record === null ? null : str(record.path);
      const changeKind = record === null ? null : str(record.kind);
      return path === null ? null : `${changeKind ?? "edit"} ${path}`;
    })
    .filter((entry): entry is string => entry !== null);
  if (paths.length > 0) {
    return collapse(paths.join(", "));
  }
  const query = str(item.query) ?? str(item.tool) ?? str(item.server);
  return query === null ? null : collapse(query);
}

function codexItemActivities(
  type: string,
  item: Record<string, unknown>,
): ReadonlyArray<HarnessAgentActivity> {
  const itemType = str(item.type) ?? "";
  const id = str(item.id) ?? itemType;

  if (itemType === "agent_message") {
    const text = str(item.text);
    return type === "item.completed" && text !== null ? [{ kind: "message", id, text }] : [];
  }
  if (itemType === "reasoning") {
    const text = str(item.text) ?? str(item.summary);
    return type === "item.completed" && text !== null ? [{ kind: "reasoning", text }] : [];
  }
  if (itemType === "todo_list") {
    const items = (Array.isArray(item.items) ? item.items : [])
      .map((entry) => {
        const record = asRecord(entry);
        const text = record === null ? null : str(record.text);
        return text === null ? null : { text, completed: record?.completed === true };
      })
      .filter((entry): entry is { text: string; completed: boolean } => entry !== null);
    return items.length === 0 ? [] : [{ kind: "todos", items }];
  }
  if (itemType === "error") {
    const message = str(item.message);
    return message === null ? [] : [{ kind: "error", message }];
  }

  const toolKind = codexToolKind(itemType);
  if (toolKind === null) {
    return [];
  }
  // `status` is the item's own; a non-zero exit is a failure even when Codex
  // still calls the item "completed".
  const status = str(item.status);
  const exitCode = num(item.exit_code);
  const failed = status === "failed" || (exitCode !== null && exitCode !== 0);
  return [
    {
      kind: "tool",
      id,
      name: itemType === "collab_tool_call" ? (str(item.tool) ?? itemType) : itemType,
      itemKind: toolKind,
      status:
        type === "item.completed" || status === "completed" || failed
          ? failed
            ? "failed"
            : "completed"
          : "started",
      detail: codexToolDetail(item),
    },
  ];
}

/**
 * Why a Claude-shaped `result` line failed, or null when it did not fail.
 *
 * Three fields can each say so on their own, because the CLI does not report a
 * failure the same way twice: `is_error` is the direct claim, a `subtype` other
 * than `success` is how a turn that ran out of turns or died mid-execution says
 * it, and `api_error_status` is the HTTP status behind an `api_error` — a line
 * can carry `subtype: "success"` and `api_error_status: 429` at once, which is
 * what a closed subscription window looks like.
 *
 * The status is prepended when it is not already in the prose, so a failure with
 * an unhelpful body still classifies correctly downstream: the number is the
 * whole difference between a limit to wait out and a server having a bad minute.
 */
function claudeResultFailure(record: Record<string, unknown>): string | null {
  const subtype = str(record.subtype);
  const status = num(record.api_error_status);
  const failed =
    record.is_error === true ||
    (subtype !== null && subtype !== "success") ||
    (status !== null && status >= 400);
  if (!failed) {
    return null;
  }

  const body = str(record.result) ?? str(record.error) ?? str(record.message);
  const prefix = status === null ? null : `HTTP ${status}`;
  if (body === null) {
    return prefix ?? `The agent failed (${subtype ?? "no reason given"}).`;
  }
  return prefix === null || body.includes(String(status)) ? body : `${prefix}: ${body}`;
}

function claudeAssistantActivities(
  message: Record<string, unknown>,
): ReadonlyArray<HarnessAgentActivity> {
  const content = Array.isArray(message.content) ? message.content : [];
  const activities: Array<HarnessAgentActivity> = [];
  const messageId = str(message.id);
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (block === null) {
      continue;
    }
    switch (block.type) {
      case "text": {
        const text = str(block.text);
        if (text !== null) {
          activities.push({ kind: "message", id: messageId, text });
        }
        break;
      }
      case "thinking": {
        const text = str(block.thinking);
        if (text !== null) {
          activities.push({ kind: "reasoning", text });
        }
        break;
      }
      case "tool_use": {
        const name = str(block.name);
        const id = str(block.id);
        if (name !== null && id !== null) {
          activities.push({
            kind: "tool",
            id,
            name,
            itemKind: claudeToolKind(name),
            status: "started",
            detail: claudeToolDetail(block.input),
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return activities;
}

function claudeUserActivities(
  message: Record<string, unknown>,
): ReadonlyArray<HarnessAgentActivity> {
  const content = Array.isArray(message.content) ? message.content : [];
  const activities: Array<HarnessAgentActivity> = [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (block === null || block.type !== "tool_result") {
      continue;
    }
    const id = str(block.tool_use_id);
    if (id === null) {
      continue;
    }
    // The result carries no tool name; the fold recovers it from the matching
    // `tool_use`, which always precedes it.
    activities.push({
      kind: "tool",
      id,
      name: "",
      itemKind: "dynamic_tool_call",
      status: block.is_error === true ? "failed" : "completed",
      detail: null,
    });
  }
  return activities;
}

/**
 * One line of a step's `events.jsonl` → the activities it represents.
 *
 * Returns an empty array for a line this build does not model — a partially
 * written line, a bare CLI notice like `Reading additional input from stdin…`,
 * or an event type the agent added since. None of those is an error.
 *
 * A single line can carry several activities: one Claude assistant message may
 * hold a thinking block, prose, and two tool calls.
 */
export function parseHarnessAgentEvent(value: unknown): ReadonlyArray<HarnessAgentActivity> {
  const record = asRecord(value);
  if (record === null) {
    return [];
  }

  switch (record.type) {
    // --- Claude / Cursor stream-json ---------------------------------------
    case "system": {
      if (record.subtype !== "init") {
        return [];
      }
      return [
        {
          kind: "session",
          model: str(record.model),
          sessionId: str(record.session_id),
          tools: strings(record.tools),
        },
      ];
    }
    case "assistant": {
      const message = asRecord(record.message);
      return message === null ? [] : claudeAssistantActivities(message);
    }
    case "user": {
      const message = asRecord(record.message);
      return message === null ? [] : claudeUserActivities(message);
    }
    case "result": {
      const usage = asRecord(record.usage) ?? {};
      const activities: Array<HarnessAgentActivity> = [
        {
          kind: "usage",
          inputTokens: num(usage.input_tokens),
          outputTokens: num(usage.output_tokens),
          cachedInputTokens: num(usage.cache_read_input_tokens),
          costUsd: num(record.total_cost_usd),
        },
      ];
      // A failed `result` line is the only place the provider explains itself.
      // When a subscription window closes mid-step, the CLI writes the sentence
      // here — "You've hit your session limit · resets 3:40pm" — and then exits
      // non-zero, and all the harness records of that exit is `claude exited 1`.
      // Dropping this line therefore loses the difference between "the window
      // reopens at 3:40" and "something crashed", which is exactly the
      // difference between waiting for the window and retrying into it a minute
      // later. So the sentence is carried out as an error activity, which
      // reaches the server as a `runtime.warning` and lets the resume logic
      // classify the failure from what the provider actually said.
      const message = claudeResultFailure(record);
      if (message !== null) {
        activities.push({ kind: "error", message });
      }
      return activities;
    }

    // --- Codex ---------------------------------------------------------------
    case "thread.started":
      return [
        {
          kind: "session",
          model: null,
          sessionId: str(record.thread_id),
          tools: [],
        },
      ];
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = asRecord(record.item);
      return item === null ? [] : codexItemActivities(record.type, item);
    }
    case "turn.completed": {
      const usage = asRecord(record.usage) ?? {};
      return [
        {
          kind: "usage",
          inputTokens: num(usage.input_tokens),
          outputTokens: num(usage.output_tokens),
          cachedInputTokens: num(usage.cached_input_tokens),
          costUsd: null,
        },
      ];
    }
    case "turn.failed": {
      const error = asRecord(record.error) ?? {};
      const message = str(error.message) ?? "The agent's turn failed.";
      return [{ kind: "error", message }];
    }
    case "error": {
      const message = str(record.message);
      return message === null ? [] : [{ kind: "error", message }];
    }

    default:
      return [];
  }
}

/** What one agent has done so far inside a single step. */
export interface HarnessAgentProgress {
  readonly model: string | null;
  readonly sessionId: string | null;
  /** Tool calls seen, whether or not they have finished. */
  readonly toolCalls: number;
  /** The tool still in flight, when one is — this is "what it is doing now". */
  readonly activeTool: { readonly name: string; readonly detail: string | null } | null;
  readonly messages: number;
  /** The most recent assistant prose, collapsed to a line. */
  readonly lastMessage: string | null;
  /** The most recent thinking block, collapsed to a line. */
  readonly lastReasoning: string | null;
  /** Which of the two came last — a watcher wants the newer one. */
  readonly lastNarration: "message" | "reasoning" | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly costUsd: number | null;
  readonly errors: ReadonlyArray<string>;
  /** The agent's checklist, when it keeps one. */
  readonly todos: ReadonlyArray<{ readonly text: string; readonly completed: boolean }>;
}

export const EMPTY_AGENT_PROGRESS: HarnessAgentProgress = {
  model: null,
  sessionId: null,
  toolCalls: 0,
  activeTool: null,
  messages: 0,
  lastMessage: null,
  lastReasoning: null,
  lastNarration: null,
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  costUsd: null,
  errors: [],
  todos: [],
};

/**
 * Fold one activity into the picture of an agent.
 *
 * Tool names are remembered by id so a Claude `tool_result`, which carries only
 * the id, can clear the right in-flight tool.
 */
export function applyAgentActivity(
  progress: HarnessAgentProgress,
  activity: HarnessAgentActivity,
  toolNames: Map<string, { name: string; detail: string | null }>,
): HarnessAgentProgress {
  switch (activity.kind) {
    case "session":
      return {
        ...progress,
        model: activity.model ?? progress.model,
        sessionId: activity.sessionId ?? progress.sessionId,
      };

    case "message":
      return {
        ...progress,
        messages: progress.messages + 1,
        lastMessage: collapse(activity.text),
        lastNarration: "message",
      };

    case "reasoning":
      return {
        ...progress,
        lastReasoning: collapse(activity.text),
        lastNarration: "reasoning",
      };

    case "tool": {
      if (activity.status === "started") {
        const entry = { name: activity.name, detail: activity.detail };
        toolNames.set(activity.id, entry);
        return { ...progress, toolCalls: progress.toolCalls + 1, activeTool: entry };
      }
      const known = toolNames.get(activity.id);
      toolNames.delete(activity.id);
      // Codex reports a completed item without ever reporting it started, so a
      // finish for an unknown id still counts as a call that happened.
      const toolCalls = known === undefined ? progress.toolCalls + 1 : progress.toolCalls;
      const activeTool =
        progress.activeTool !== null &&
        known !== undefined &&
        progress.activeTool.name === known.name &&
        progress.activeTool.detail === known.detail
          ? null
          : progress.activeTool;
      return { ...progress, toolCalls, activeTool };
    }

    case "todos":
      return { ...progress, todos: activity.items };

    case "usage":
      return {
        ...progress,
        inputTokens: activity.inputTokens ?? progress.inputTokens,
        outputTokens: activity.outputTokens ?? progress.outputTokens,
        cachedInputTokens: activity.cachedInputTokens ?? progress.cachedInputTokens,
        costUsd: activity.costUsd ?? progress.costUsd,
      };

    case "error":
      return { ...progress, errors: [...progress.errors, activity.message] };
  }
}

function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

/**
 * The live one-liner for a running step: who is working, and on what.
 *
 * Ordered by what a watcher actually wants — the tool in flight first, because
 * that is the answer to "is it stuck?".
 */
export function describeAgentProgress(input: {
  readonly command: HarnessStepCommand | null;
  readonly progress: HarnessAgentProgress;
}): string {
  const { command, progress } = input;
  const who = [command?.agent, progress.model ?? command?.model].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  const parts: Array<string> = [];
  if (who.length > 0) {
    parts.push(who.join(" · "));
  }
  if (progress.activeTool !== null) {
    const { name, detail } = progress.activeTool;
    parts.push(detail === null ? name : `${name}: ${collapse(detail, 80)}`);
  } else if (progress.lastNarration === "reasoning" && progress.lastReasoning !== null) {
    parts.push(`thinking: ${collapse(progress.lastReasoning, 80)}`);
  } else if (progress.lastMessage !== null) {
    parts.push(collapse(progress.lastMessage, 80));
  } else if (progress.lastReasoning !== null) {
    parts.push(`thinking: ${collapse(progress.lastReasoning, 80)}`);
  }
  if (progress.toolCalls > 0) {
    parts.push(`${progress.toolCalls} tool${progress.toolCalls === 1 ? "" : "s"}`);
  }
  const done = progress.todos.filter((todo) => todo.completed).length;
  if (progress.todos.length > 0) {
    parts.push(`${done}/${progress.todos.length} todo`);
  }
  if (progress.outputTokens !== null) {
    parts.push(`${formatTokens(progress.outputTokens)} out`);
  }
  if (progress.costUsd !== null) {
    parts.push(`$${progress.costUsd.toFixed(4)}`);
  }
  return parts.length === 0 ? "starting…" : parts.join(" · ");
}

/** The tail of a shell node's `output.txt`, for the same live one-liner. */
export function describeCommandOutput(output: string, lines = 3): string | null {
  const kept = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-lines);
  return kept.length === 0 ? null : kept.join("\n");
}
