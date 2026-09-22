/**
 * HarnessAdapter — Agent Harness workflow runs as a provider adapter.
 *
 * A harness run is a batch, not a conversation. One `sendTurn` spawns
 * `agent-harness run … --execute --json` and the whole turn is that process:
 * there is no steering, no approval channel, and no mid-run model switch.
 *
 * Progress does not come from stdout. The harness appends JSON lines to
 * `<harness home>/runs/<run id>/events.jsonl`, and the run id is only knowable
 * after the fact — so the adapter notes which run directories existed before it
 * spawned, waits for a new one whose first `run.started` names the repo and
 * workflow it launched, and then tails that file by byte offset until the
 * process is gone and the bytes stop arriving.
 *
 * That file is only the run-level ledger — node started, node finished — and a
 * single node can hold an agent for twenty minutes, which is why a run watched
 * through it alone looks stalled. So each running step is tailed too: its
 * `steps/<NN>-<node>/` directory holds the role and model in `command.json`,
 * and the agent's own stream becomes ordinary message and tool items on the
 * thread while the node is still open.
 *
 * That stream is not the step's `events.jsonl`. The harness collects the agent's
 * stdout in a temporary file and writes `events.jsonl` only once the node has
 * exited, so during the whole of a long node it does not exist. What is written
 * as the agent goes is the Claude CLI's own transcript, under its `projects`
 * directory and keyed by the `--session-id` the harness pinned in
 * `command.json` — the same `stream-json` shapes, in a file that grows. A step
 * adopts whichever of the two it finds first and keeps it, so a stream that is
 * present in both is never rendered twice. A node run by another provider, or a
 * shell node, has no transcript and stays on `events.jsonl`.
 *
 * The event→UI translation is `mapHarnessEventToRuntimeEvents` for the run and
 * `mapAgentActivityToRuntimeEvents` for the agent inside a step, both kept pure
 * and exported so they can be tested without a subprocess.
 *
 * @module provider/Layers/HarnessAdapter
 */
import {
  EventId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  applyHarnessEvent,
  buildHarnessArgs,
  harnessFailureReason,
  EMPTY_RUN_PROGRESS,
  type HarnessEvent,
  type HarnessRunProgress,
  parseHarnessEvent,
} from "@t3tools/shared/harnessRun";
import {
  applyAgentActivity,
  describeAgentProgress,
  describeCommandOutput,
  EMPTY_AGENT_PROGRESS,
  harnessStepDirName,
  harnessStepTranscriptSegments,
  type HarnessAgentActivity,
  type HarnessAgentProgress,
  type HarnessStepCommand,
  parseHarnessAgentEvent,
  parseHarnessStepCommand,
} from "@t3tools/shared/harnessStepStream";
import { patchHarnessConfig, type HarnessRoleOverride } from "@t3tools/shared/harnessConfigPatch";
import { HARNESS_CONFIG_ENV } from "@t3tools/shared/harnessWorkflow";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { HarnessCatalogService } from "../../harness/HarnessCatalog.ts";
import { resolveHarnessBinary, resolveHarnessHome } from "../../harness/HarnessBinary.ts";
import { resolveHarnessConfigSource } from "../../harness/HarnessConfigSource.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

export const HARNESS_DRIVER_KIND = ProviderDriverKind.make("harness");

/** How often the events file is re-read while a run is in flight. */
const POLL_INTERVAL_MILLIS = 200;
/**
 * How long a finished step's tail gets to flush what the agent last wrote.
 *
 * Generous, because a step reading `events.jsonl` sees the node's entire stream
 * — megabytes of it for a long node — arrive in the single pass after the
 * process exits, and interrupting that drain does not delay the row, it loses
 * the node's whole account of itself. A step on the live transcript is already
 * caught up by the time this is reached and closes immediately.
 */
const STEP_TAIL_DRAIN_TIMEOUT_MILLIS = "30 seconds";
/** Extra passes over the events file after the process is gone. */
const DRAIN_PASSES_AFTER_EXIT = 3;
/** Keep the tail of stderr for the failure message, not the whole thing. */
const STDERR_TAIL_LIMIT = 4_000;
/**
 * Same for stdout, where the `--json` result lands. Larger, because that result
 * carries the run's step list ahead of the `error` the message needs.
 */
const STDOUT_TAIL_LIMIT = 32_000;

const decoder = new TextDecoder();

const decodeJsonLineExit = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

/**
 * One line of `events.jsonl`, or null when it is not an event this build
 * models — a partially written or unknown line must not abort the tail.
 */
function parseEventLine(line: string): HarnessEvent | null {
  const decoded = decodeJsonLineExit(line);
  return Exit.isSuccess(decoded) ? parseHarnessEvent(decoded.value) : null;
}

export interface HarnessAdapterOptions {
  /** Workflow names offered as models. Validated against the repo at run time. */
  readonly workflows: ReadonlyArray<string>;
  /** Explicit `agent-harness` path; falls back to `AGENT_HARNESS_BIN`, then `PATH`. */
  readonly binPath?: string | undefined;
  /** Overrides `AGENT_HARNESS_HOME` — where `runs/<id>/events.jsonl` lives. */
  readonly harnessHome?: string | undefined;
  readonly allowDirty?: boolean | undefined;
  /**
   * Per-role provider/model overrides, keyed by workflow then role. The CLI has
   * no per-role flags, so these are applied by patching the repository's config
   * into a generated one and passing that with `--config`.
   */
  readonly roleOverrides?:
    | Readonly<Record<string, Readonly<Record<string, HarnessRoleOverride>>>>
    | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly instanceId?: ProviderInstanceId | undefined;
}

/**
 * Everything the pure mapping needs that is not on the harness event itself.
 *
 * `progress` is the run *after* the event has been folded in, which is what
 * lets `run.finished` report the workspace, step count, and summed cost
 * without the mapper keeping state of its own.
 */
export interface HarnessMappingContext {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly createdAt: string;
  /** When false, `run.started` opens the turn. */
  readonly turnStarted: boolean;
  readonly progress: HarnessRunProgress;
}

function stepItemId(runId: string, step: number): RuntimeItemId {
  return RuntimeItemId.make(`harness:${runId}:step:${step}`);
}

function describeStepStart(event: {
  readonly kind: string;
  readonly step: number;
  readonly visit: number;
}): string {
  const visit = event.visit > 1 ? `, visit ${event.visit}` : "";
  return `${event.kind} step ${event.step}${visit}`;
}

function describeStepFinish(event: {
  readonly success: boolean;
  readonly agent: string | null;
  readonly models: ReadonlyArray<string>;
  readonly durationSeconds: number | null;
  readonly costUsd: number | null;
  readonly error: string | null;
  readonly timedOut: boolean;
}): string {
  const parts: Array<string> = [event.success ? "succeeded" : "failed"];
  if (event.agent !== null) {
    parts.push(`agent ${event.agent}`);
  }
  if (event.models.length > 0) {
    parts.push(`models ${event.models.join(", ")}`);
  }
  if (event.durationSeconds !== null) {
    parts.push(`${event.durationSeconds.toFixed(1)}s`);
  }
  if (event.costUsd !== null) {
    parts.push(`$${event.costUsd.toFixed(4)}`);
  }
  if (event.timedOut) {
    parts.push("timed out");
  }
  const head = parts.join(" · ");
  return event.error === null ? head : `${head}\n${event.error}`;
}

function describeRunFinish(progress: HarnessRunProgress, workspace: string | null): string {
  const lines = [
    `Harness run ${progress.status} (${progress.steps.length} step${progress.steps.length === 1 ? "" : "s"}).`,
  ];
  if (progress.elapsedSeconds !== null) {
    lines.push(`Elapsed: ${progress.elapsedSeconds.toFixed(1)}s`);
  }
  if (progress.costUsd !== null) {
    lines.push(`Cost: $${progress.costUsd.toFixed(4)}`);
  }
  lines.push(
    workspace === null ? "No workspace was created for this run." : `Workspace: ${workspace}`,
  );
  const failed = progress.steps.filter((step) => step.status === "failed");
  for (const step of failed) {
    lines.push(`Failed at ${step.node}${step.error === null ? "" : `: ${step.error}`}`);
  }
  return lines.join("\n");
}

/**
 * One harness event → the runtime events the thread UI should see.
 *
 * Ids are derived from the run id and the step number rather than generated,
 * so the same run always produces the same event and item ids.
 */
export function mapHarnessEventToRuntimeEvents(
  context: HarnessMappingContext,
  event: HarnessEvent,
): ReadonlyArray<ProviderRuntimeEvent> {
  const base = {
    provider: context.provider,
    ...(context.providerInstanceId !== undefined
      ? { providerInstanceId: context.providerInstanceId }
      : {}),
    threadId: context.threadId,
    turnId: context.turnId,
    createdAt: context.createdAt,
  };
  const eventId = (suffix: string) => EventId.make(`harness:${event.runId}:${suffix}`);

  switch (event.type) {
    case "run.started": {
      const events: Array<ProviderRuntimeEvent> = [];
      if (!context.turnStarted) {
        events.push({
          ...base,
          eventId: eventId("turn-started"),
          type: "turn.started",
          payload: { model: event.workflow },
        });
      }
      events.push({
        ...base,
        eventId: eventId("announce"),
        itemId: RuntimeItemId.make(`harness:${event.runId}:announce`),
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: "completed",
          title: "Agent Harness run",
          detail: `Running workflow \`${event.workflow}\` (run ${event.runId}).`,
        },
      });
      return events;
    }

    case "step.started":
      return [
        {
          ...base,
          eventId: eventId(`step-started-${event.step}`),
          itemId: stepItemId(event.runId, event.step),
          type: "item.started",
          payload: {
            itemType: "dynamic_tool_call",
            status: "inProgress",
            title: event.node,
            detail: describeStepStart(event),
            data: {
              toolCallId: `harness:${event.runId}:step:${event.step}`,
              node: event.node,
              step: event.step,
              visit: event.visit,
              kind: event.kind,
            },
          },
        },
      ];

    case "step.finished": {
      const events: Array<ProviderRuntimeEvent> = [
        {
          ...base,
          eventId: eventId(`step-finished-${event.step}`),
          itemId: stepItemId(event.runId, event.step),
          type: "item.completed",
          payload: {
            itemType: "dynamic_tool_call",
            status: event.success ? "completed" : "failed",
            title: event.node,
            detail: describeStepFinish(event),
            data: {
              toolCallId: `harness:${event.runId}:step:${event.step}`,
              node: event.node,
              step: event.step,
              success: event.success,
              agent: event.agent,
              models: event.models,
              costUsd: event.costUsd,
              durationSeconds: event.durationSeconds,
              exitCode: event.exitCode,
              timedOut: event.timedOut,
              error: event.error,
            },
          },
        },
      ];
      // The harness reports cost and models but never token counts, so the
      // usage snapshot carries only what was actually measured.
      if (event.costUsd !== null || event.models.length > 0) {
        events.push({
          ...base,
          eventId: eventId(`step-usage-${event.step}`),
          itemId: stepItemId(event.runId, event.step),
          type: "thread.token-usage.updated",
          payload: {
            usage: {
              usedTokens: 0,
              ...(event.durationSeconds !== null
                ? { durationMs: Math.max(0, Math.round(event.durationSeconds * 1000)) }
                : {}),
            },
          },
        });
      }
      return events;
    }

    case "run.finished": {
      const failure = context.progress.steps.find((step) => step.status === "failed");
      const errorMessage =
        event.status === "done"
          ? undefined
          : (failure?.error ?? `Harness run finished with status '${event.status}'.`);
      return [
        {
          ...base,
          eventId: eventId("summary"),
          itemId: RuntimeItemId.make(`harness:${event.runId}:summary`),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Agent Harness result",
            detail: describeRunFinish(context.progress, event.workspace),
            data: {
              status: event.status,
              steps: event.steps,
              elapsedSeconds: event.elapsedSeconds,
              workspace: event.workspace,
              costUsd: context.progress.costUsd,
            },
          },
        },
        {
          ...base,
          eventId: eventId("turn-completed"),
          type: "turn.completed",
          payload: {
            state: event.status === "done" ? "completed" : "failed",
            stopReason: event.status,
            ...(context.progress.costUsd !== null
              ? { totalCostUsd: context.progress.costUsd }
              : {}),
            ...(errorMessage !== undefined ? { errorMessage } : {}),
          },
        },
      ];
    }
  }
}

/**
 * Everything the step-level mapping needs beyond the activity itself.
 *
 * `sequence` only makes event ids unique — the harness's own stream has no
 * counter to borrow, and a step can emit the same activity shape many times.
 */
export interface HarnessStepMappingContext {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly createdAt: string;
  readonly runId: string;
  readonly step: number;
  readonly node: string;
  readonly sequence: number;
}

const TOOL_STATUS: Record<
  "started" | "completed" | "failed",
  "inProgress" | "completed" | "failed"
> = {
  started: "inProgress",
  completed: "completed",
  failed: "failed",
};

/** Long agent prose belongs in the thread, but not without a ceiling. */
const MESSAGE_DETAIL_LIMIT = 8_000;

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * One agent activity inside a running step → the runtime events the thread UI
 * should see.
 *
 * Messages become assistant messages and tool calls become tool items, so a
 * harness node reads like an ordinary agent turn while it is still running.
 * Reasoning, todos, and usage are deliberately not items of their own: they are
 * folded into the node's live one-liner instead, which is what
 * `describeAgentProgress` produces.
 */
export function mapAgentActivityToRuntimeEvents(
  context: HarnessStepMappingContext,
  activity: HarnessAgentActivity,
): ReadonlyArray<ProviderRuntimeEvent> {
  const base = {
    provider: context.provider,
    ...(context.providerInstanceId !== undefined
      ? { providerInstanceId: context.providerInstanceId }
      : {}),
    threadId: context.threadId,
    turnId: context.turnId,
    createdAt: context.createdAt,
  };
  const prefix = `harness:${context.runId}:step:${context.step}`;
  const eventId = (suffix: string) => EventId.make(`${prefix}:e${context.sequence}:${suffix}`);

  switch (activity.kind) {
    case "message":
      return [
        {
          ...base,
          eventId: eventId("message"),
          itemId: RuntimeItemId.make(`${prefix}:msg:${context.sequence}`),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: context.node,
            detail: truncate(activity.text, MESSAGE_DETAIL_LIMIT),
          },
        },
      ];

    case "tool": {
      const itemId = RuntimeItemId.make(`${prefix}:tool:${activity.id}`);
      const title = activity.name.length > 0 ? activity.name : context.node;
      return [
        {
          ...base,
          eventId: eventId(`tool-${activity.status}`),
          itemId,
          type: activity.status === "started" ? "item.started" : "item.completed",
          payload: {
            itemType: activity.itemKind,
            status: TOOL_STATUS[activity.status],
            title,
            ...(activity.detail !== null ? { detail: activity.detail } : {}),
            data: {
              toolCallId: `${prefix}:tool:${activity.id}`,
              node: context.node,
              step: context.step,
              tool: title,
            },
          },
        },
      ];
    }

    case "error":
      // A warning, not an error: the step may still recover, and the run's own
      // failure — if it comes — is reported by `step.finished`.
      return [
        {
          ...base,
          eventId: eventId("agent-error"),
          type: "runtime.warning",
          payload: {
            message: `${context.node}: ${activity.message}`,
          },
        },
      ];

    case "session":
    case "reasoning":
    case "todos":
    case "usage":
      return [];
  }
}

/**
 * The live one-liner for a node, as an update to the node's own item.
 *
 * Emitted on every change rather than on every event, so a chatty agent does
 * not turn into a chatty event stream.
 */
export function makeStepProgressEvent(
  context: HarnessStepMappingContext,
  input: {
    readonly detail: string;
    readonly command: HarnessStepCommand | null;
    readonly progress: HarnessAgentProgress;
  },
): ProviderRuntimeEvent {
  return {
    provider: context.provider,
    ...(context.providerInstanceId !== undefined
      ? { providerInstanceId: context.providerInstanceId }
      : {}),
    threadId: context.threadId,
    turnId: context.turnId,
    createdAt: context.createdAt,
    eventId: EventId.make(
      `harness:${context.runId}:step:${context.step}:progress:${context.sequence}`,
    ),
    itemId: stepItemId(context.runId, context.step),
    type: "item.updated",
    payload: {
      itemType: "dynamic_tool_call",
      status: "inProgress",
      title: context.node,
      detail: input.detail,
      data: {
        // The work log collapses adjacent tool rows that share this id, so the
        // node keeps one row that updates rather than a row per change.
        toolCallId: `harness:${context.runId}:step:${context.step}`,
        node: context.node,
        step: context.step,
        provider: input.command?.provider ?? null,
        agent: input.command?.agent ?? null,
        model: input.progress.model ?? input.command?.model ?? null,
        mode: input.command?.mode ?? null,
        toolCalls: input.progress.toolCalls,
        activeTool: input.progress.activeTool?.name ?? null,
        messages: input.progress.messages,
        todos: input.progress.todos,
        outputTokens: input.progress.outputTokens,
        costUsd: input.progress.costUsd,
      },
    },
  } as ProviderRuntimeEvent;
}

interface HarnessRunState {
  readonly turnId: TurnId;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly fiber: Fiber.Fiber<void, never>;
  interrupted: boolean;
}

interface HarnessSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  session: ProviderSession;
  workflow: string | undefined;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  run: HarnessRunState | undefined;
  stopped: boolean;
}

function humanErrorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function makeHarnessAdapter(options: HarnessAdapterOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathModule = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const catalog = yield* HarnessCatalogService;
    const hostEnvironment = yield* HostProcessEnvironment;
    const platform = yield* HostProcessPlatform;

    const environment = options.environment ?? hostEnvironment;
    const sessions = new Map<ThreadId, HarnessSessionContext>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    /**
     * Where the Claude CLI keeps its per-session transcripts.
     *
     * The harness spawns the CLI with the environment resolved here, so the
     * same `CLAUDE_CONFIG_DIR` precedence the CLI itself applies is what finds
     * the file it is writing.
     */
    const claudeProjectsDir = pathModule.join(
      environment.CLAUDE_CONFIG_DIR?.trim() ||
        pathModule.join(environment.HOME ?? environment.USERPROFILE ?? ".", ".claude"),
      "projects",
    );

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomId = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: HARNESS_DRIVER_KIND,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate a harness runtime identifier.",
            cause,
          }),
      ),
    );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const emit = (
      input: Omit<ProviderRuntimeEvent, "eventId" | "provider" | "createdAt" | "threadId"> & {
        readonly threadId: ThreadId;
      },
    ) =>
      Effect.gen(function* () {
        const event = {
          ...input,
          eventId: EventId.make(`harness:local:${yield* randomId}`),
          provider: HARNESS_DRIVER_KIND,
          ...(options.instanceId !== undefined ? { providerInstanceId: options.instanceId } : {}),
          createdAt: yield* nowIso,
        } as ProviderRuntimeEvent;
        yield* offerRuntimeEvent(event);
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<HarnessSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: HARNESS_DRIVER_KIND, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const killRun = (ctx: HarnessSessionContext) =>
      ctx.run === undefined
        ? Effect.void
        : Effect.ignore(ctx.run.child.kill()).pipe(
            Effect.tap(() => Fiber.interrupt(ctx.run!.fiber).pipe(Effect.ignore)),
          );

    const stopSessionInternal = (ctx: HarnessSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* killRun(ctx);
        ctx.run = undefined;
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* emit({
          threadId: ctx.threadId,
          type: "session.exited",
          payload: { exitKind: "graceful" },
        });
      });

    /**
     * The run directory the harness just created, or null while it has not
     * appeared yet. Matched on the first `run.started` rather than on
     * timestamps, so a concurrent run in another repo cannot be adopted.
     */
    const discoverRunDirectory = (input: {
      readonly runsDir: string;
      readonly known: ReadonlySet<string>;
      readonly repo: string;
      readonly workflow: string;
    }) =>
      Effect.gen(function* () {
        const entries = yield* fileSystem
          .readDirectory(input.runsDir)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
        for (const entry of entries) {
          if (input.known.has(entry)) {
            continue;
          }
          const eventsPath = pathModule.join(input.runsDir, entry, "events.jsonl");
          const contents = yield* fileSystem
            .readFileString(eventsPath)
            .pipe(Effect.orElseSucceed(() => ""));
          const firstLine = contents.split("\n").find((line) => line.trim().length > 0);
          if (firstLine === undefined) {
            continue;
          }
          const parsed = parseEventLine(firstLine);
          if (
            parsed !== null &&
            parsed.type === "run.started" &&
            parsed.workflow === input.workflow &&
            pathModule.resolve(parsed.repo) === input.repo
          ) {
            return pathModule.join(input.runsDir, entry);
          }
        }
        return null;
      });

    /**
     * Tail one step's directory for as long as that step is running.
     *
     * The run-level ledger says only that a node started; this is where the
     * agent inside it becomes visible. `command.json` lands before the spawn and
     * names the role, the model, and — for a Claude node — the session whose
     * live transcript is the stream this reads; `events.jsonl` is the same
     * stream for every other node, though not until that node has exited, and
     * `output.txt` plays the part for a shell node.
     *
     * `stopRef` is set by the run tail when `step.finished` arrives, and is
     * honoured only after one more pass, so the last few lines an agent wrote
     * before exiting are not dropped.
     */
    const tailStep = (input: {
      readonly ctx: HarnessSessionContext;
      readonly turnId: TurnId;
      readonly runId: string;
      readonly runDir: string;
      readonly step: number;
      readonly node: string;
      readonly stopRef: Ref.Ref<boolean>;
    }) =>
      Effect.gen(function* () {
        const directory = pathModule.join(
          input.runDir,
          "steps",
          harnessStepDirName(input.step, input.node),
        );
        const toolNames = new Map<string, { name: string; detail: string | null }>();

        let command: HarnessStepCommand | null = null;
        let progress: HarnessAgentProgress = EMPTY_AGENT_PROGRESS;
        let eventsOffset = 0;
        let outputOffset = 0;
        let carry = "";
        let outputTail = "";
        let sequence = 0;
        let lastKey: string | null = null;
        let finalPass = false;
        /**
         * The file this step's agent stream is being read from, once one
         * exists. Adopted once and kept: both candidates hold the same stream,
         * and switching part-way would replay from a byte offset that means
         * nothing in the other file.
         */
        let streamPath: string | null = null;

        const stepEventsPath = pathModule.join(directory, "events.jsonl");

        const isFile = (candidate: string) =>
          fileSystem.stat(candidate).pipe(
            Effect.map((info) => info.type === "File"),
            Effect.orElseSucceed(() => false),
          );

        /**
         * Prefer the live transcript when the step has one: `events.jsonl` only
         * appears once the node is over, and a node that is over is exactly the
         * one nobody needs to watch.
         */
        const resolveStreamPath = Effect.gen(function* () {
          if (streamPath !== null) {
            return streamPath;
          }
          const segments = harnessStepTranscriptSegments(command);
          if (segments !== null) {
            const transcript = pathModule.join(claudeProjectsDir, ...segments);
            if (yield* isFile(transcript)) {
              streamPath = transcript;
              return streamPath;
            }
          }
          if (yield* isFile(stepEventsPath)) {
            streamPath = stepEventsPath;
            return streamPath;
          }
          return null;
        });

        const context = (): Effect.Effect<HarnessStepMappingContext> =>
          Effect.map(nowIso, (createdAt) => ({
            provider: HARNESS_DRIVER_KIND,
            ...(options.instanceId !== undefined ? { providerInstanceId: options.instanceId } : {}),
            threadId: input.ctx.threadId,
            turnId: input.turnId,
            createdAt,
            runId: input.runId,
            step: input.step,
            node: input.node,
            sequence: (sequence += 1),
          }));

        /**
         * Push the node's live one-liner, but only when what a watcher would
         * act on changed: the role, the model, or the tool in flight. Token
         * counts and prose move constantly and would otherwise turn one row
         * into a stream of them — the prose still rides along in the detail.
         */
        const publishProgress = Effect.gen(function* () {
          const isShellNode = command !== null && command.provider === null;
          const detail = isShellNode
            ? (describeCommandOutput(outputTail) ??
              `running ${command?.argv[0] ?? "command"}${outputTail.length > 0 ? "" : "…"}`)
            : describeAgentProgress({ command, progress });
          const key = isShellNode
            ? detail
            : [
                command?.agent ?? "",
                progress.model ?? command?.model ?? "",
                progress.activeTool?.name ?? "",
                progress.activeTool?.detail ?? "",
                progress.todos.filter((todo) => todo.completed).length,
                progress.todos.length,
              ].join("");
          if (key === lastKey) {
            return;
          }
          lastKey = key;
          yield* offerRuntimeEvent(
            makeStepProgressEvent(yield* context(), { detail, command, progress }),
          );
        });

        while (true) {
          if (command === null) {
            const raw = yield* fileSystem
              .readFileString(pathModule.join(directory, "command.json"))
              .pipe(Effect.orElseSucceed(() => ""));
            if (raw.trim().length > 0) {
              const decoded = decodeJsonLineExit(raw);
              command = Exit.isSuccess(decoded) ? parseHarnessStepCommand(decoded.value) : null;
              if (command !== null) {
                yield* publishProgress;
              }
            }
          }

          const stream = yield* resolveStreamPath;
          const eventsBytes =
            stream === null
              ? new Uint8Array()
              : yield* fileSystem
                  .readFile(stream)
                  .pipe(Effect.orElseSucceed(() => new Uint8Array()));
          if (eventsBytes.byteLength > eventsOffset) {
            carry += decoder.decode(eventsBytes.slice(eventsOffset));
            eventsOffset = eventsBytes.byteLength;
            const lines = carry.split("\n");
            carry = lines.pop() ?? "";
            for (const line of lines) {
              if (line.trim().length === 0) {
                continue;
              }
              const decoded = decodeJsonLineExit(line);
              if (!Exit.isSuccess(decoded)) {
                continue;
              }
              for (const rawActivity of parseHarnessAgentEvent(decoded.value)) {
                // A Claude tool result names only the id it answers; the fold
                // keeps the names, so recover one before it is rendered.
                const remembered =
                  rawActivity.kind === "tool" && rawActivity.name.length === 0
                    ? toolNames.get(rawActivity.id)
                    : undefined;
                const activity: HarnessAgentActivity =
                  rawActivity.kind === "tool" && remembered !== undefined
                    ? {
                        ...rawActivity,
                        name: remembered.name,
                        detail: rawActivity.detail ?? remembered.detail,
                      }
                    : rawActivity;
                // Folded before mapping so the tool that is now in flight, and
                // the one just cleared, are both correct in the same pass.
                const mapped = mapAgentActivityToRuntimeEvents(yield* context(), activity);
                progress = applyAgentActivity(progress, activity, toolNames);
                for (const runtimeEvent of mapped) {
                  yield* offerRuntimeEvent(runtimeEvent);
                }
              }
            }
            yield* publishProgress;
          }

          // A shell node has no agent stream; its output is the only progress
          // there is, and only its tail is worth carrying.
          if (command !== null && command.provider === null) {
            const outputBytes = yield* fileSystem
              .readFile(pathModule.join(directory, "output.txt"))
              .pipe(Effect.orElseSucceed(() => new Uint8Array()));
            if (outputBytes.byteLength > outputOffset) {
              outputTail = `${outputTail}${decoder.decode(outputBytes.slice(outputOffset))}`.slice(
                -STDERR_TAIL_LIMIT,
              );
              outputOffset = outputBytes.byteLength;
              yield* publishProgress;
            }
          }

          if (finalPass) {
            return;
          }
          if (yield* Ref.get(input.stopRef)) {
            finalPass = true;
            continue;
          }
          yield* Effect.sleep(`${POLL_INTERVAL_MILLIS} millis`);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Failed while tailing a harness step.", {
            cause,
            step: input.step,
            node: input.node,
          }),
        ),
        Effect.asVoid,
      );

    /**
     * Tail `events.jsonl` by byte offset until the process is gone and the
     * bytes stop arriving, translating each line into runtime events.
     */
    const tailRun = (input: {
      readonly ctx: HarnessSessionContext;
      readonly turnId: TurnId;
      readonly child: ChildProcessSpawner.ChildProcessHandle;
      readonly runsDir: string;
      readonly known: ReadonlySet<string>;
      readonly repo: string;
      readonly workflow: string;
      readonly turnStartedRef: Ref.Ref<boolean>;
      readonly runFinishedRef: Ref.Ref<boolean>;
    }) =>
      Effect.gen(function* () {
        let runDir: string | null = null;
        let offset = 0;
        let carry = "";
        let progress: HarnessRunProgress = EMPTY_RUN_PROGRESS;
        let drainPasses = 0;
        // One tail per running step, so an agent's own work is visible while
        // its node is still open. Keyed by step number: a repair loop revisits
        // a node, and each visit is its own step.
        const stepTails = new Map<
          number,
          { readonly fiber: Fiber.Fiber<void, never>; readonly stopRef: Ref.Ref<boolean> }
        >();

        /** Let a step's tail finish its last pass, then let it go. */
        const closeStepTail = (step: number) =>
          Effect.gen(function* () {
            const tail = stepTails.get(step);
            if (tail === undefined) {
              return;
            }
            stepTails.delete(step);
            yield* Ref.set(tail.stopRef, true);
            const joined = yield* Fiber.join(tail.fiber).pipe(
              Effect.ignore,
              Effect.timeoutOption(STEP_TAIL_DRAIN_TIMEOUT_MILLIS),
            );
            if (Option.isNone(joined)) {
              yield* Fiber.interrupt(tail.fiber).pipe(Effect.ignore);
            }
          });

        while (true) {
          if (runDir === null) {
            runDir = yield* discoverRunDirectory({
              runsDir: input.runsDir,
              known: input.known,
              repo: input.repo,
              workflow: input.workflow,
            });
          }

          if (runDir !== null) {
            const eventsPath = pathModule.join(runDir, "events.jsonl");
            const bytes = yield* fileSystem
              .readFile(eventsPath)
              .pipe(Effect.orElseSucceed(() => new Uint8Array()));
            if (bytes.byteLength > offset) {
              carry += decoder.decode(bytes.slice(offset));
              offset = bytes.byteLength;
              const lines = carry.split("\n");
              carry = lines.pop() ?? "";
              for (const line of lines) {
                if (line.trim().length === 0) {
                  continue;
                }
                const parsed = parseEventLine(line);
                if (parsed === null) {
                  continue;
                }
                progress = applyHarnessEvent(progress, parsed);
                // Drained before the node's own completion is reported, so the
                // agent's last words arrive before the row closes.
                if (parsed.type === "step.finished") {
                  yield* closeStepTail(parsed.step);
                }
                const runtimeEvents = mapHarnessEventToRuntimeEvents(
                  {
                    provider: HARNESS_DRIVER_KIND,
                    ...(options.instanceId !== undefined
                      ? { providerInstanceId: options.instanceId }
                      : {}),
                    threadId: input.ctx.threadId,
                    turnId: input.turnId,
                    createdAt: yield* nowIso,
                    turnStarted: yield* Ref.get(input.turnStartedRef),
                    progress,
                  },
                  parsed,
                );
                for (const runtimeEvent of runtimeEvents) {
                  if (runtimeEvent.type === "turn.started") {
                    yield* Ref.set(input.turnStartedRef, true);
                  }
                  yield* offerRuntimeEvent(runtimeEvent);
                }
                if (parsed.type === "step.started" && runDir !== null) {
                  yield* closeStepTail(parsed.step);
                  const stopRef = yield* Ref.make(false);
                  const fiber = yield* Effect.forkChild(
                    tailStep({
                      ctx: input.ctx,
                      turnId: input.turnId,
                      runId: parsed.runId,
                      runDir,
                      step: parsed.step,
                      node: parsed.node,
                      stopRef,
                    }),
                  );
                  stepTails.set(parsed.step, { fiber, stopRef });
                }
                if (parsed.type === "run.finished") {
                  yield* Ref.set(input.runFinishedRef, true);
                  return;
                }
              }
            }
          }

          const running = yield* input.child.isRunning.pipe(Effect.orElseSucceed(() => false));
          if (!running) {
            drainPasses += 1;
            if (drainPasses >= DRAIN_PASSES_AFTER_EXIT) {
              // The harness died without reporting a result: whatever the agent
              // managed to write is the only account of what happened.
              yield* Effect.forEach(Array.from(stepTails.keys()), closeStepTail, {
                discard: true,
              });
              return;
            }
          }
          yield* Effect.sleep(`${POLL_INTERVAL_MILLIS} millis`);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Failed while tailing the harness run.", { cause }),
        ),
        Effect.asVoid,
      );

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== HARNESS_DRIVER_KIND) {
          return yield* new ProviderAdapterValidationError({
            provider: HARNESS_DRIVER_KIND,
            operation: "startSession",
            issue: `Expected provider '${HARNESS_DRIVER_KIND}' but received '${input.provider}'.`,
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: HARNESS_DRIVER_KIND,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }

        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) {
          yield* stopSessionInternal(existing);
        }

        const cwd = pathModule.resolve(input.cwd.trim());
        const workflow =
          input.modelSelection?.instanceId === options.instanceId ||
          options.instanceId === undefined
            ? input.modelSelection?.model
            : undefined;
        const sessionScope = yield* Scope.make("sequential");
        const now = yield* nowIso;
        const session: ProviderSession = {
          provider: HARNESS_DRIVER_KIND,
          ...(options.instanceId !== undefined ? { providerInstanceId: options.instanceId } : {}),
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          ...(workflow !== undefined ? { model: workflow } : {}),
          threadId: input.threadId,
          createdAt: now,
          updatedAt: now,
        };

        sessions.set(input.threadId, {
          threadId: input.threadId,
          scope: sessionScope,
          session,
          workflow,
          turns: [],
          run: undefined,
          stopped: false,
        });

        yield* emit({
          threadId: input.threadId,
          type: "session.started",
          payload: { message: "Agent Harness session ready" },
        });
        yield* emit({
          threadId: input.threadId,
          type: "session.state.changed",
          payload: { state: "ready", reason: "Agent Harness session ready" },
        });

        return session;
      });

    /**
     * Workflow names the config actually defines — the repository's own when it
     * declares one, otherwise the global config.
     */
    const resolveWorkflow = (input: {
      readonly cwd: string;
      readonly workflow: string;
      readonly harnessHome: string;
    }) =>
      Effect.gen(function* () {
        const read = yield* catalog.read({ cwd: input.cwd, harnessHome: input.harnessHome });
        if (Option.isSome(read.unavailable)) {
          return yield* new ProviderAdapterValidationError({
            provider: HARNESS_DRIVER_KIND,
            operation: "sendTurn",
            issue: `No usable agent-harness config for '${input.cwd}', and no global config to fall back on (${Option.getOrElse(read.unavailable, () => "unknown")}). Declare one in the repository or set ${HARNESS_CONFIG_ENV}.`,
          });
        }
        const names = read.workflows.map((entry) => entry.name);
        if (!names.includes(input.workflow)) {
          // Naming the file matters here: the same workflow can exist in the
          // global config and be absent from a repository that shadows it with
          // one of its own.
          const source = Option.match(read.configPath, {
            onNone: () => "the resolved config",
            onSome: (path) => {
              const scope = Option.getOrElse(read.configScope, () => "repository");
              if (scope === "global") return `the global config '${path}'`;
              if (scope === "merged") return `'${path}' merged with the global config`;
              return `'${path}'`;
            },
          });
          return yield* new ProviderAdapterValidationError({
            provider: HARNESS_DRIVER_KIND,
            operation: "sendTurn",
            issue: `Workflow '${input.workflow}' is not defined in ${source}. Available: ${names.join(", ") || "none"}.`,
          });
        }
        return { configPath: Option.getOrNull(read.configPath) };
      });

    /** Writes a derived config beside the harness's state and names the file. */
    const writeGeneratedConfig = (input: {
      readonly toml: string;
      readonly workflow: string;
      readonly harnessHome: string;
      readonly threadId: ThreadId;
    }) =>
      Effect.gen(function* () {
        const directory = pathModule.join(input.harnessHome, "t3-generated-configs");
        yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(Effect.ignore);
        const generated = pathModule.join(directory, `${input.threadId}-${input.workflow}.toml`);
        yield* fileSystem.writeFileString(generated, input.toml).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterValidationError({
                provider: HARNESS_DRIVER_KIND,
                operation: "sendTurn",
                issue: `Could not write the generated harness config: ${String(cause)}`,
              }),
          ),
        );
        return generated;
      });

    /**
     * The config the run should actually use.
     *
     * A repository with no config of its own runs straight off the global file,
     * and one that shadows it entirely runs off its own — in both cases the
     * file on disk is passed through untouched. When both exist they are merged
     * (repository tables winning), and when roles are overridden the text is
     * patched — not re-serialized. Anything generated is written beside the
     * harness's own state, so it is inspectable afterwards and the repository
     * is never modified.
     */
    const materializeConfig = (input: {
      readonly cwd: string;
      readonly configPath: string | null;
      readonly workflow: string;
      readonly harnessHome: string;
      readonly threadId: ThreadId;
    }) =>
      Effect.gen(function* () {
        const overrides = options.roleOverrides?.[input.workflow] ?? {};
        const overriddenRoles = Object.keys(overrides);

        const source = yield* resolveHarnessConfigSource({
          fileSystem,
          pathModule,
          environment,
          cwd: input.cwd,
          harnessHome: input.harnessHome,
        });
        const merged = source.kind === "ok" && source.scope === "merged";

        // Nothing to generate: the file the catalog found is the file the
        // harness should read.
        if (overriddenRoles.length === 0 && !merged) {
          return input.configPath;
        }

        if (source.kind !== "ok") {
          if (!merged && overriddenRoles.length === 0) {
            return input.configPath;
          }
          return yield* new ProviderAdapterValidationError({
            provider: HARNESS_DRIVER_KIND,
            operation: "sendTurn",
            issue:
              "Role overrides are configured but this repository's harness config could not be read to apply them.",
          });
        }

        const original = source.toml;
        if (overriddenRoles.length === 0) {
          return yield* writeGeneratedConfig({
            toml: original,
            workflow: input.workflow,
            harnessHome: input.harnessHome,
            threadId: input.threadId,
          });
        }

        const patched = patchHarnessConfig(original, overrides);
        if (patched.missingRoles.length > 0) {
          return yield* new ProviderAdapterValidationError({
            provider: HARNESS_DRIVER_KIND,
            operation: "sendTurn",
            issue: `Workflow '${input.workflow}' has no role named ${patched.missingRoles
              .map((role) => `'${role}'`)
              .join(", ")}. Clear the override or rename it.`,
          });
        }

        return yield* writeGeneratedConfig({
          toml: patched.toml,
          workflow: input.workflow,
          harnessHome: input.harnessHome,
          threadId: input.threadId,
        });
      });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (ctx.run !== undefined) {
          // A run whose tail has finished and whose process is gone is not in
          // flight — it is the wreckage of one that was abandoned before it
          // could let go. Refusing every later turn would make that permanent,
          // so drop it and start the new one instead.
          const abandoned =
            ctx.run.fiber.pollUnsafe() !== undefined &&
            !(yield* ctx.run.child.isRunning.pipe(Effect.orElseSucceed(() => false)));
          if (!abandoned) {
            return yield* new ProviderAdapterValidationError({
              provider: HARNESS_DRIVER_KIND,
              operation: "sendTurn",
              issue: "A harness run is already in flight for this thread.",
            });
          }
          ctx.run = undefined;
        }

        const task = input.input?.trim();
        if (!task) {
          return yield* new ProviderAdapterValidationError({
            provider: HARNESS_DRIVER_KIND,
            operation: "sendTurn",
            issue: "A harness run requires a non-empty task.",
          });
        }

        const selection =
          options.instanceId === undefined ||
          input.modelSelection?.instanceId === options.instanceId
            ? input.modelSelection?.model
            : undefined;
        const workflow = selection ?? ctx.workflow ?? options.workflows[0];
        if (workflow === undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: HARNESS_DRIVER_KIND,
            operation: "sendTurn",
            issue: "No workflow selected and none configured.",
          });
        }

        const repo = ctx.session.cwd ?? pathModule.resolve(".");

        // Resolved before the workflow: it is also where the global config that
        // serves repositories without one of their own is looked for.
        const harnessHome = resolveHarnessHome({
          pathModule,
          environment,
          ...(options.harnessHome !== undefined ? { override: options.harnessHome } : {}),
        });

        // The harness home is a state directory, not the launcher. Pointing it
        // at a file is an easy mistake — it sits next to "Binary path" in
        // settings — and the harness only reports it much later, as an
        // ENOTDIR from deep inside its own run directory.
        const homeInfo = yield* fileSystem.stat(harnessHome).pipe(
          Effect.map(Option.some),
          Effect.orElseSucceed(() => Option.none<FileSystem.File.Info>()),
        );
        if (Option.isSome(homeInfo) && homeInfo.value.type !== "Directory") {
          return yield* new ProviderAdapterValidationError({
            provider: HARNESS_DRIVER_KIND,
            operation: "sendTurn",
            issue: `Harness home '${harnessHome}' is not a directory. It is where runs and worktrees are kept — the agent-harness executable belongs in "Binary path" instead. Clear it to use the default.`,
          });
        }

        const { configPath } = yield* resolveWorkflow({ cwd: repo, workflow, harnessHome });

        const binary = yield* resolveHarnessBinary({
          fileSystem,
          pathModule,
          pathEnv: environment.PATH ?? "",
          platform,
          ...(options.binPath !== undefined || environment.AGENT_HARNESS_BIN !== undefined
            ? { override: options.binPath ?? environment.AGENT_HARNESS_BIN }
            : {}),
        });
        if (binary === null) {
          return yield* new ProviderAdapterProcessError({
            provider: HARNESS_DRIVER_KIND,
            threadId: input.threadId,
            detail: "agent-harness not found; set AGENT_HARNESS_BIN or add it to PATH.",
          });
        }

        const runsDir = pathModule.join(harnessHome, "runs");
        const known = new Set(
          yield* fileSystem
            .readDirectory(runsDir)
            .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>)),
        );

        const turnId = TurnId.make(yield* randomId);
        ctx.workflow = workflow;
        ctx.session = {
          ...ctx.session,
          model: workflow,
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };
        ctx.turns.push({ id: turnId, items: [{ workflow, task }] });

        const effectiveConfigPath = yield* materializeConfig({
          cwd: repo,
          configPath,
          workflow,
          harnessHome,
          threadId: input.threadId,
        });

        const args = buildHarnessArgs({
          repo,
          workflow,
          task,
          ...(effectiveConfigPath !== null ? { configPath: effectiveConfigPath } : {}),
          ...(options.allowDirty === true ? { allowDirty: true } : {}),
        });
        const spawnEnv: NodeJS.ProcessEnv = {
          ...environment,
          ...binary.env,
          AGENT_HARNESS_HOME: harnessHome,
        };
        const spawnCommand = yield* resolveSpawnCommand(binary.executable, args, {
          env: spawnEnv,
          extendEnv: true,
        });

        const child = yield* spawner
          .spawn(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              cwd: repo,
              env: spawnEnv,
              extendEnv: true,
              shell: spawnCommand.shell,
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, ctx.scope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: HARNESS_DRIVER_KIND,
                  threadId: input.threadId,
                  detail: `Failed to spawn agent-harness: ${humanErrorText(cause)}`,
                  cause,
                }),
            ),
          );

        const turnStartedRef = yield* Ref.make(false);
        const runFinishedRef = yield* Ref.make(false);
        const stderrRef = yield* Ref.make("");
        const stdoutRef = yield* Ref.make("");
        // Whether the turn reached an ending of its own — the run reporting one,
        // or this fiber reporting the process's failure.
        const settledRef = yield* Ref.make(false);

        // Both pipes have to be drained or a chatty harness fills its buffers
        // and stalls — and only their tails are worth keeping. stdout matters
        // as well as stderr: a run that fails before any agent starts (a repo
        // that is not a Git checkout, say) reports why in the `--json` result
        // on stdout and exits non-zero with nothing on stderr at all.
        yield* Stream.runForEach(child.stderr, (chunk) =>
          Ref.update(stderrRef, (current) =>
            `${current}${decoder.decode(chunk)}`.slice(-STDERR_TAIL_LIMIT),
          ),
        ).pipe(Effect.ignore, Effect.forkScoped, Effect.provideService(Scope.Scope, ctx.scope));
        yield* Stream.runForEach(child.stdout, (chunk) =>
          Ref.update(stdoutRef, (current) =>
            `${current}${decoder.decode(chunk)}`.slice(-STDOUT_TAIL_LIMIT),
          ),
        ).pipe(Effect.ignore, Effect.forkScoped, Effect.provideService(Scope.Scope, ctx.scope));

        const fiber = yield* tailRun({
          ctx,
          turnId,
          child,
          runsDir,
          known,
          repo,
          workflow,
          turnStartedRef,
          runFinishedRef,
        }).pipe(Effect.forkScoped, Effect.provideService(Scope.Scope, ctx.scope));

        ctx.run = { turnId, child, fiber, interrupted: false };

        // However this fiber ends — a failure, or an interrupt because the
        // caller's turn was cancelled — the run has to be let go of. A `ctx.run`
        // left behind outlives the process it describes, and every later turn
        // on the thread is then refused as "already in flight".
        const releaseRun = Effect.suspend(() => {
          const running = ctx.run;
          if (running === undefined || running.turnId !== turnId) {
            return Effect.void;
          }
          ctx.run = undefined;
          return Effect.ignore(running.child.kill()).pipe(
            Effect.tap(() => Fiber.interrupt(running.fiber).pipe(Effect.ignore)),
            // Only reached when the turn never got to report for itself: the
            // thread would otherwise keep showing a turn that nothing is
            // working on any more.
            Effect.tap(() =>
              Effect.gen(function* () {
                if (yield* Ref.get(settledRef)) return;
                if (!(yield* Ref.get(turnStartedRef))) return;
                yield* emit({
                  threadId: input.threadId,
                  turnId,
                  type: "turn.completed",
                  payload: { state: "interrupted", stopReason: "interrupted" },
                });
              }),
            ),
          );
        });

        yield* Effect.gen(function* () {
          const exitCode = yield* child.exitCode.pipe(
            Effect.map((code) => Number(code)),
            Effect.orElseSucceed(() => null),
          );
          yield* Fiber.join(fiber).pipe(Effect.ignore);

          const finished = yield* Ref.get(runFinishedRef);
          const interrupted = ctx.run?.interrupted === true;

          if (!finished) {
            const stderr = (yield* Ref.get(stderrRef)).trim();
            // The harness's own account of the failure, when it managed to
            // write one, beats anything we could infer from an exit code.
            const reported = harnessFailureReason(yield* Ref.get(stdoutRef));
            const reason = reported ?? (stderr.length > 0 ? stderr : null);
            if (!(yield* Ref.get(turnStartedRef))) {
              yield* emit({
                threadId: input.threadId,
                turnId,
                type: "turn.started",
                payload: { model: workflow },
              });
            }
            if (!interrupted) {
              yield* emit({
                threadId: input.threadId,
                turnId,
                type: "runtime.error",
                payload: {
                  message:
                    reported ??
                    `agent-harness exited with code ${exitCode ?? "unknown"} before reporting a result.`,
                  class: "provider_error",
                  ...(stderr.length > 0 ? { detail: stderr } : {}),
                },
              });
            }
            yield* emit({
              threadId: input.threadId,
              turnId,
              type: "turn.completed",
              payload: {
                state: interrupted ? "interrupted" : "failed",
                stopReason: interrupted ? "interrupted" : `exit:${exitCode ?? "unknown"}`,
                ...(interrupted
                  ? {}
                  : {
                      errorMessage:
                        reason !== null
                          ? reason.slice(-500)
                          : `agent-harness exited with code ${exitCode ?? "unknown"}.`,
                    }),
              },
            });
          }
          yield* Ref.set(settledRef, true);
        }).pipe(Effect.onExit(() => releaseRun));

        ctx.session = { ...ctx.session, updatedAt: yield* nowIso };
        return { threadId: input.threadId, turnId };
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (ctx.run === undefined) {
          return;
        }
        ctx.run.interrupted = true;
        // Kill by the handle we hold — never by name or pattern.
        yield* Effect.ignore(ctx.run.child.kill());
      });

    const unsupported = (method: string) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: HARNESS_DRIVER_KIND,
          method,
          detail:
            "Agent Harness runs are non-interactive: there is no approval or question channel to respond on.",
        }),
      );

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = () =>
      unsupported("respondToRequest");

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] =
      () => unsupported("respondToUserInput");

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* stopSessionInternal(ctx);
      });

    const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId,
      numTurns,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: HARNESS_DRIVER_KIND,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
        return { threadId, turns: ctx.turns };
      });

    const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, {
        discard: true,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Failed to stop harness sessions on shutdown.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
      ),
    );

    return {
      provider: HARNESS_DRIVER_KIND,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
