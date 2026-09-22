/**
 * The Agent Harness run protocol: how a run is invoked, and what it reports.
 *
 * A run is a batch, not a conversation. `agent-harness run … --execute --json`
 * spawns one process that drives several agents through a workflow's nodes in
 * an isolated worktree, and reports progress by appending JSON lines to
 * `<harness home>/runs/<run id>/events.jsonl`.
 *
 * Four event types matter, in this order:
 *
 *   run.started    — names the workflow, repo, and run id
 *   step.started   — one workflow node begins
 *   step.finished  — that node's outcome, with the agent, model, and cost
 *   run.finished   — terminal status and the worktree the work landed in
 *
 * Everything here is pure: spawning the process and tailing the file is the
 * server's job.
 */

export interface HarnessRunStartedEvent {
  readonly type: "run.started";
  readonly runId: string;
  readonly workflow: string;
  readonly repo: string;
  readonly configPath: string | null;
  readonly at: string;
}

export interface HarnessStepStartedEvent {
  readonly type: "step.started";
  readonly runId: string;
  readonly node: string;
  readonly step: number;
  /** Which pass over this node — a repair loop revisits one. */
  readonly visit: number;
  /** "agent", "command", "gate", … */
  readonly kind: string;
  readonly at: string;
}

export interface HarnessStepFinishedEvent {
  readonly type: "step.finished";
  readonly runId: string;
  readonly node: string;
  readonly step: number;
  readonly success: boolean;
  /** The workflow role that ran, e.g. `codex_architect`. */
  readonly agent: string | null;
  /** Models the role actually used, as reported by its provider. */
  readonly models: ReadonlyArray<string>;
  readonly costUsd: number | null;
  readonly durationSeconds: number | null;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly error: string | null;
  readonly at: string;
}

export interface HarnessRunFinishedEvent {
  readonly type: "run.finished";
  readonly runId: string;
  /** "done", "failed", … — the harness's own vocabulary, not normalised. */
  readonly status: string;
  readonly steps: number;
  readonly elapsedSeconds: number | null;
  /** The worktree the run's changes are in, when it got far enough to make one. */
  readonly workspace: string | null;
  readonly at: string;
}

export type HarnessEvent =
  | HarnessRunStartedEvent
  | HarnessStepStartedEvent
  | HarnessStepFinishedEvent
  | HarnessRunFinishedEvent;

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

function int(value: unknown, fallback = 0): number {
  const parsed = num(value);
  return parsed === null ? fallback : Math.trunc(parsed);
}

function strings(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * One line of `events.jsonl`.
 *
 * Returns null for a line this build does not model — the harness may add
 * event types, and an unknown one is not an error.
 */
export function parseHarnessEvent(value: unknown): HarnessEvent | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const runId = str(record.run_id);
  const at = str(record.time) ?? "";
  if (runId === null) {
    return null;
  }

  switch (record.type) {
    case "run.started": {
      const workflow = str(record.workflow);
      return workflow === null
        ? null
        : {
            type: "run.started",
            runId,
            workflow,
            repo: str(record.repo) ?? "",
            configPath: str(record.config),
            at,
          };
    }
    case "step.started":
      return {
        type: "step.started",
        runId,
        node: str(record.node) ?? "",
        step: int(record.step),
        visit: int(record.visit, 1),
        kind: str(record.kind) ?? "agent",
        at,
      };
    case "step.finished": {
      const details = asRecord(record.details) ?? {};
      const metadata = asRecord(details.metadata) ?? {};
      return {
        type: "step.finished",
        runId,
        node: str(record.node) ?? "",
        step: int(record.step),
        success: record.success === true,
        agent: str(details.agent),
        models: strings(metadata.models),
        costUsd: num(details.cost_usd),
        durationSeconds: num(details.duration_seconds),
        exitCode: num(details.exit_code),
        timedOut: details.timed_out === true,
        error: str(details.error),
        at,
      };
    }
    case "run.finished":
      return {
        type: "run.finished",
        runId,
        status: str(record.status) ?? "unknown",
        steps: int(record.steps),
        elapsedSeconds: num(record.elapsed_seconds),
        workspace: str(record.workspace),
        at,
      };
    default:
      return null;
  }
}

export type HarnessStepStatus = "running" | "succeeded" | "failed";

export interface HarnessStepProgress {
  readonly node: string;
  readonly step: number;
  readonly visit: number;
  readonly kind: string;
  readonly status: HarnessStepStatus;
  readonly agent: string | null;
  readonly models: ReadonlyArray<string>;
  readonly costUsd: number | null;
  readonly durationSeconds: number | null;
  readonly error: string | null;
}

export type HarnessRunStatus = "pending" | "running" | "succeeded" | "failed";

export interface HarnessRunProgress {
  readonly runId: string | null;
  readonly workflow: string | null;
  readonly status: HarnessRunStatus;
  readonly steps: ReadonlyArray<HarnessStepProgress>;
  readonly workspace: string | null;
  readonly elapsedSeconds: number | null;
  /** Summed from the steps that reported one; null when none did. */
  readonly costUsd: number | null;
}

export const EMPTY_RUN_PROGRESS: HarnessRunProgress = {
  runId: null,
  workflow: null,
  status: "pending",
  steps: [],
  workspace: null,
  elapsedSeconds: null,
  costUsd: null,
};

/**
 * Fold one event into the picture of a run.
 *
 * A node can be revisited — a repair loop runs `implement` twice — so steps are
 * keyed by step number rather than node name, which is what keeps the second
 * attempt from overwriting the first one's outcome.
 */
export function applyHarnessEvent(
  progress: HarnessRunProgress,
  event: HarnessEvent,
): HarnessRunProgress {
  switch (event.type) {
    case "run.started":
      return {
        ...progress,
        runId: event.runId,
        workflow: event.workflow,
        status: "running",
      };

    case "step.started": {
      const step: HarnessStepProgress = {
        node: event.node,
        step: event.step,
        visit: event.visit,
        kind: event.kind,
        status: "running",
        agent: null,
        models: [],
        costUsd: null,
        durationSeconds: null,
        error: null,
      };
      return {
        ...progress,
        status: "running",
        steps: [...progress.steps.filter((entry) => entry.step !== event.step), step].sort(
          (left, right) => left.step - right.step,
        ),
      };
    }

    case "step.finished": {
      const existing = progress.steps.find((entry) => entry.step === event.step);
      const step: HarnessStepProgress = {
        node: event.node,
        step: event.step,
        visit: existing?.visit ?? 1,
        kind: existing?.kind ?? "agent",
        status: event.success ? "succeeded" : "failed",
        agent: event.agent,
        models: event.models,
        costUsd: event.costUsd,
        durationSeconds: event.durationSeconds,
        error: event.error,
      };
      const steps = [...progress.steps.filter((entry) => entry.step !== event.step), step].sort(
        (left, right) => left.step - right.step,
      );
      const costed = steps.filter((entry) => entry.costUsd !== null);
      return {
        ...progress,
        steps,
        costUsd:
          costed.length === 0 ? null : costed.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0),
      };
    }

    case "run.finished":
      return {
        ...progress,
        runId: progress.runId ?? event.runId,
        // The harness's own status is authoritative: a run can end "failed"
        // with every reported step green when a gate rejected the result.
        status: event.status === "done" ? "succeeded" : "failed",
        workspace: event.workspace,
        elapsedSeconds: event.elapsedSeconds,
      };
  }
}

/**
 * Why a `--json` run failed, read out of what it printed on stdout.
 *
 * A run that never reaches an agent — an unknown workflow, a workspace that
 * cannot be prepared, a repository that is not a Git checkout — writes no
 * events and nothing on stderr. It prints its final state as JSON and exits 1,
 * so that JSON is the only place the reason exists. Returns null when stdout
 * holds no failure worth reporting, including for a run that succeeded.
 *
 * Tolerates a truncated document: callers keep only the tail of stdout, so the
 * open brace may be long gone by the time this runs.
 */
export function harnessFailureReason(stdout: string): string | null {
  const text = stdout.trim();
  if (text.length === 0) return null;

  const describe = (error: unknown, phase: unknown): string | null => {
    if (typeof error !== "string" || error.trim().length === 0) return null;
    return typeof phase === "string" && phase.trim().length > 0
      ? `agent-harness failed during ${phase}: ${error.trim()}`
      : `agent-harness failed: ${error.trim()}`;
  };

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") {
      const state = parsed as Record<string, unknown>;
      if (state.status === "done") return null;
      return describe(state.error, state.phase);
    }
  } catch {
    // Fall through to the tolerant scan below.
  }

  // Truncated JSON: take the last `"error": "..."` the document mentions.
  const pattern = /"error"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let last: string | null = null;
  for (const match of text.matchAll(pattern)) {
    const raw = match[1];
    if (raw === undefined) continue;
    try {
      last = JSON.parse(`"${raw}"`) as string;
    } catch {
      last = raw;
    }
  }
  return last === null ? null : describe(last, undefined);
}

export interface HarnessInvocation {
  readonly repo: string;
  readonly workflow: string;
  readonly task: string;
  readonly configPath?: string | null;
  readonly allowDirty?: boolean;
}

/**
 * Argv for `agent-harness`, after the executable.
 *
 * `--task` goes last on purpose: a prompt can be very long, and keeping it in
 * the final position makes the command readable when it is logged truncated.
 */
export function buildHarnessArgs(input: HarnessInvocation): ReadonlyArray<string> {
  const args = ["run", "--repo", input.repo];
  if (input.configPath) {
    args.push("--config", input.configPath);
  }
  args.push(input.workflow, "--execute", "--json");
  if (input.allowDirty === true) {
    args.push("--allow-dirty");
  }
  args.push("--task", input.task);
  return args;
}
