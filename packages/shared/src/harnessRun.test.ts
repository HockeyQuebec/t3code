import { describe, expect, it } from "vite-plus/test";

import {
  applyHarnessEvent,
  buildHarnessArgs,
  harnessFailureReason,
  EMPTY_RUN_PROGRESS,
  type HarnessRunProgress,
  parseHarnessEvent,
} from "./harnessRun.ts";

// Copied from a real events.jsonl, not invented.
const RUN_STARTED = {
  config: "/repo/.agent-harness.toml",
  config_sha256: "e9be7f",
  repo: "/repo",
  run_id: "20260804-204638-7ad0ede8",
  time: "2026-08-05T00:46:38.936944+00:00",
  type: "run.started",
  workflow: "evaluated_change",
};

const STEP_STARTED = {
  kind: "agent",
  node: "plan",
  run_id: "20260804-204638-7ad0ede8",
  step: 1,
  time: "2026-08-05T00:46:39.126031+00:00",
  type: "step.started",
  visit: 1,
};

const STEP_FINISHED = {
  details: {
    agent: "codex_architect",
    cost_usd: null,
    duration_seconds: 3.127,
    error: "codex exited 1",
    exit_code: 1,
    metadata: { models: ["gpt-5.6-sol"], usage: {} },
    session_id: "019fcf62",
    success: false,
    timed_out: false,
  },
  node: "plan",
  run_id: "20260804-204638-7ad0ede8",
  step: 1,
  success: false,
  time: "2026-08-05T00:46:42.258601+00:00",
  type: "step.finished",
};

const RUN_FINISHED = {
  elapsed_seconds: 3.324,
  run_id: "20260804-204638-7ad0ede8",
  status: "failed",
  steps: 1,
  time: "2026-08-05T00:46:42.376054+00:00",
  type: "run.finished",
  workspace: "/harness/worktrees/repo-abc",
};

function fold(raw: ReadonlyArray<unknown>): HarnessRunProgress {
  return raw.reduce<HarnessRunProgress>((progress, line) => {
    const event = parseHarnessEvent(line);
    return event === null ? progress : applyHarnessEvent(progress, event);
  }, EMPTY_RUN_PROGRESS);
}

describe("parseHarnessEvent", () => {
  it("reads a real run.started line", () => {
    expect(parseHarnessEvent(RUN_STARTED)).toEqual({
      type: "run.started",
      runId: "20260804-204638-7ad0ede8",
      workflow: "evaluated_change",
      repo: "/repo",
      configPath: "/repo/.agent-harness.toml",
      at: "2026-08-05T00:46:38.936944+00:00",
    });
  });

  it("lifts the agent, model, and failure out of a step.finished detail block", () => {
    const event = parseHarnessEvent(STEP_FINISHED);
    expect(event?.type).toBe("step.finished");
    if (event?.type !== "step.finished") return;

    expect(event.agent).toBe("codex_architect");
    expect(event.models).toEqual(["gpt-5.6-sol"]);
    expect(event.success).toBe(false);
    expect(event.exitCode).toBe(1);
    expect(event.error).toBe("codex exited 1");
    expect(event.costUsd).toBeNull();
  });

  it("ignores lines it does not model rather than failing the run", () => {
    expect(parseHarnessEvent({ type: "something.new", run_id: "r1" })).toBeNull();
    expect(parseHarnessEvent({ type: "run.started" })).toBeNull();
    expect(parseHarnessEvent("not an object")).toBeNull();
    expect(parseHarnessEvent(null)).toBeNull();
  });
});

describe("applyHarnessEvent", () => {
  it("folds a real failing run into progress", () => {
    const progress = fold([RUN_STARTED, STEP_STARTED, STEP_FINISHED, RUN_FINISHED]);

    expect(progress.runId).toBe("20260804-204638-7ad0ede8");
    expect(progress.workflow).toBe("evaluated_change");
    expect(progress.status).toBe("failed");
    expect(progress.workspace).toBe("/harness/worktrees/repo-abc");
    expect(progress.elapsedSeconds).toBeCloseTo(3.324, 5);
    expect(progress.steps).toHaveLength(1);
    expect(progress.steps[0]?.status).toBe("failed");
    expect(progress.steps[0]?.agent).toBe("codex_architect");
  });

  it("marks a run running as soon as it starts", () => {
    expect(fold([RUN_STARTED]).status).toBe("running");
    expect(EMPTY_RUN_PROGRESS.status).toBe("pending");
  });

  it("keeps a revisited node's attempts as separate steps", () => {
    const progress = fold([
      RUN_STARTED,
      { ...STEP_STARTED, node: "implement", step: 2, visit: 1 },
      { ...STEP_FINISHED, node: "implement", step: 2, success: false },
      { ...STEP_STARTED, node: "implement", step: 3, visit: 2 },
      {
        ...STEP_FINISHED,
        node: "implement",
        step: 3,
        success: true,
        details: { ...STEP_FINISHED.details, success: true, error: null, cost_usd: 0.5 },
      },
    ]);

    // Two attempts at the same node, kept apart by step number.
    expect(progress.steps).toHaveLength(2);
    expect(progress.steps.map((step) => step.node)).toEqual(["implement", "implement"]);
    expect(progress.steps.map((step) => step.status)).toEqual(["failed", "succeeded"]);
    expect(progress.steps[1]?.visit).toBe(2);
  });

  it("sums cost only across steps that reported one", () => {
    const costed = (step: number, cost: number | null): unknown => ({
      ...STEP_FINISHED,
      step,
      success: true,
      details: { ...STEP_FINISHED.details, success: true, cost_usd: cost },
    });

    expect(fold([RUN_STARTED, costed(1, null)]).costUsd).toBeNull();
    expect(fold([RUN_STARTED, costed(1, 0.25), costed(2, 0.75)]).costUsd).toBeCloseTo(1.0, 5);
  });

  it("trusts the harness's terminal status over the steps", () => {
    // Every step green but the run rejected by a gate.
    const progress = fold([
      RUN_STARTED,
      { ...STEP_FINISHED, success: true, details: { ...STEP_FINISHED.details, success: true } },
      RUN_FINISHED,
    ]);
    expect(progress.steps[0]?.status).toBe("succeeded");
    expect(progress.status).toBe("failed");
  });

  it("reports a completed run as succeeded", () => {
    expect(fold([RUN_STARTED, { ...RUN_FINISHED, status: "done" }]).status).toBe("succeeded");
  });
});

describe("buildHarnessArgs", () => {
  it("matches the invocation the CLI documents", () => {
    expect(
      buildHarnessArgs({ repo: "/repo", workflow: "evaluated_change", task: "clean up the UX" }),
    ).toEqual([
      "run",
      "--repo",
      "/repo",
      "evaluated_change",
      "--execute",
      "--json",
      "--task",
      "clean up the UX",
    ]);
  });

  it("adds the optional config and dirty-worktree exception", () => {
    const args = buildHarnessArgs({
      repo: "/repo",
      workflow: "vibe_code",
      task: "t",
      configPath: "/repo/custom.toml",
      allowDirty: true,
    });

    expect(args.slice(0, 6)).toEqual([
      "run",
      "--repo",
      "/repo",
      "--config",
      "/repo/custom.toml",
      "vibe_code",
    ]);
    expect(args).toContain("--allow-dirty");
    // The prompt stays last so a truncated log still reads correctly.
    expect(args[args.length - 2]).toBe("--task");
  });
});

describe("harnessFailureReason", () => {
  it("reports the reason a run that never started an agent gives", () => {
    // What `agent-harness run --json` prints when the workspace cannot be
    // prepared: exit 1, nothing on stderr, the reason only here.
    const stdout = JSON.stringify({
      run_id: "20260806-232952-9c94e39d",
      status: "failed",
      phase: "workspace",
      steps: 0,
      error: "worktree mode requires a Git repository with at least one commit",
    });

    expect(harnessFailureReason(stdout)).toBe(
      "agent-harness failed during workspace: worktree mode requires a Git repository with at least one commit",
    );
  });

  it("says nothing about a run that finished", () => {
    expect(harnessFailureReason(JSON.stringify({ status: "done", steps: 11 }))).toBeNull();
    expect(harnessFailureReason("")).toBeNull();
    expect(harnessFailureReason("   \n")).toBeNull();
  });

  it("still finds the reason in a document truncated to its tail", () => {
    const truncated = `d": 3, "error": "in_place execution refuses a dirty repository", "ended_at": "…`;

    expect(harnessFailureReason(truncated)).toBe(
      "agent-harness failed: in_place execution refuses a dirty repository",
    );
  });

  it("ignores a failure with no reason attached", () => {
    expect(harnessFailureReason(JSON.stringify({ status: "failed", error: "" }))).toBeNull();
    expect(harnessFailureReason("not json at all")).toBeNull();
  });
});
