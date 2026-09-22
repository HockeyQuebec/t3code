/**
 * The harness adapter against a real run directory on disk.
 *
 * `HarnessAdapter.test.ts` covers the two pure mappings. This covers the part
 * that made a run look stalled: whether the files a harness writes while a node
 * is open actually reach the thread. The harness itself is replaced by a
 * spawner that writes the same files it would.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, type ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vite-plus/test";

import { layer as harnessCatalogLayer } from "../../harness/HarnessCatalog.ts";
import { makeHarnessAdapter } from "./HarnessAdapter.ts";

const encoder = new TextEncoder();
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const THREAD_ID = ThreadId.make("thread-harness-tail");
const INSTANCE_ID = ProviderInstanceId.make("harness");
const RUN_ID = "20260806-031906-eda0d844";
/** Pinned by the harness in `command.json`, and the transcript's file name. */
const SESSION_ID = "e2aad58a-0d3b-4bf7-821b-daab280315d2";
/** The node's cwd — a worktree — is what names the CLI's project directory. */
const STEP_CWD = "/worktrees/demo";

const CONFIG = `version = 1

[agents.builder]
provider = "claude"
mode = "write"
model = "sonnet"

[workflows.demo]
entrypoint = "implement"

[workflows.demo.nodes.implement]
kind = "agent"
agent = "builder"
`;

/** Pinned so the run does not depend on the developer's own harness setup. */
const isolatedEnvironment = (pathModule: Path.Path, home: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  XDG_CONFIG_HOME: pathModule.join(home, ".config"),
  AGENT_HARNESS_HOME: pathModule.join(home, ".local", "share", "agent-harness"),
});

function jsonLines(lines: ReadonlyArray<unknown>): string {
  return `${lines.map((line) => encodeJson(line)).join("\n")}\n`;
}

/**
 * Longer than the adapter's poll interval, so each append is a separate pass
 * over the files — which is the whole point: a run that only reports at the end
 * is the bug this feature fixes.
 */
const STAGE_DELAY = "300 millis";

/**
 * The harness, as far as the adapter can tell: a process that appends to
 * `events.jsonl` and to its step's own files while it works.
 */
const driveRun = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathModule: Path.Path;
  readonly harnessHome: string;
  readonly repo: string;
  /**
   * Where the agent's stream is appended as it works. The harness itself
   * writes the step's `events.jsonl` only once the node has exited, so which
   * file this is decides whether a watcher sees anything before then.
   */
  readonly agentStreamPath?: string | undefined;
  /**
   * Withhold the step's `events.jsonl` until the node is over, the way the
   * harness does. The stream still lands there in full — just too late to
   * watch.
   */
  readonly stepEventsAtEnd?: boolean | undefined;
}) =>
  Effect.gen(function* () {
    const fs = input.fileSystem;
    const pathModule = input.pathModule;
    const runDirectory = pathModule.join(input.harnessHome, "runs", RUN_ID);
    const stepDirectory = pathModule.join(runDirectory, "steps", "01-implement");
    const runEvents = pathModule.join(runDirectory, "events.jsonl");
    const stepEvents = pathModule.join(stepDirectory, "events.jsonl");
    const agentStream = input.agentStreamPath ?? stepEvents;
    const append = (path: string, contents: string) =>
      fs.writeFileString(path, contents, { flag: "a" });
    yield* fs.makeDirectory(stepDirectory, { recursive: true });
    yield* fs.makeDirectory(pathModule.dirname(agentStream), { recursive: true });

    yield* fs.writeFileString(
      runEvents,
      jsonLines([
        {
          type: "run.started",
          run_id: RUN_ID,
          workflow: "demo",
          repo: input.repo,
          config: pathModule.join(input.repo, ".agent-harness.toml"),
          time: "2026-08-06T07:19:06Z",
        },
        {
          type: "step.started",
          run_id: RUN_ID,
          node: "implement",
          step: 1,
          visit: 1,
          kind: "agent",
          time: "2026-08-06T07:19:07Z",
        },
      ]),
    );

    // Written before the agent is spawned: this is what names the role and
    // model while the node is still open.
    yield* fs.writeFileString(
      pathModule.join(stepDirectory, "command.json"),
      encodeJson({
        provider: "claude",
        agent: "builder",
        model: "sonnet",
        mode: "write",
        argv: ["claude", "-p", "--session-id", SESSION_ID],
        cwd: STEP_CWD,
      }),
    );
    yield* Effect.sleep(STAGE_DELAY);

    const agentLines: ReadonlyArray<unknown> = [
      {
        type: "system",
        subtype: "init",
        model: "claude-sonnet-4-5",
        session_id: "session-1",
        tools: ["Read", "Edit", "Bash"],
      },
      {
        type: "assistant",
        message: {
          id: "msg_1",
          content: [
            { type: "text", text: "Editing the router." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Edit",
              input: { file_path: "/worktrees/demo/src/router.ts" },
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
      { type: "result", total_cost_usd: 0.42, usage: { input_tokens: 10, output_tokens: 2000 } },
    ];

    for (const line of agentLines) {
      yield* append(agentStream, jsonLines([line]));
      yield* Effect.sleep(STAGE_DELAY);
    }

    if (input.stepEventsAtEnd === true) {
      yield* fs.writeFileString(stepEvents, jsonLines(agentLines));
    }

    yield* append(
      runEvents,
      jsonLines([
        {
          type: "step.finished",
          run_id: RUN_ID,
          node: "implement",
          step: 1,
          success: true,
          details: {
            agent: "builder",
            cost_usd: 0.42,
            duration_seconds: 30,
            exit_code: 0,
            timed_out: false,
            error: null,
            metadata: { models: ["claude-sonnet-4-5"] },
          },
          time: "2026-08-06T07:19:37Z",
        },
        {
          type: "run.finished",
          run_id: RUN_ID,
          status: "done",
          steps: 1,
          elapsed_seconds: 31,
          workspace: pathModule.join(input.harnessHome, "worktrees", `demo-${RUN_ID}`),
          time: "2026-08-06T07:19:38Z",
        },
      ]),
    );
  }).pipe(Effect.ignore);

/**
 * A process that never says anything: everything the adapter learns, it learns
 * from the files. `isRunning` stays true so the tail is driven by `run.finished`
 * rather than by the process going away.
 */
function spawnerLayer() {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.sync(() =>
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode("")),
          stderr: Stream.make(encoder.encode("")),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    ),
  );
}

it.live("surfaces an agent's own work while its node is still open", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathModule = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-tail-home-" });
    const repo = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-tail-repo-" });
    const harnessHome = pathModule.join(home, ".local", "share", "agent-harness");
    yield* fs.makeDirectory(harnessHome, { recursive: true });
    yield* fs.writeFileString(pathModule.join(repo, ".agent-harness.toml"), CONFIG);

    // A stand-in for the executable: it is never run, but it has to resolve.
    const binPath = pathModule.join(home, "agent-harness");
    yield* fs.writeFileString(binPath, "#!/bin/sh\nexit 0\n");
    yield* fs.chmod(binPath, 0o755);

    const environment = isolatedEnvironment(pathModule, home);
    const adapter = yield* makeHarnessAdapter({
      workflows: ["demo"],
      binPath,
      harnessHome,
      environment,
      instanceId: INSTANCE_ID,
    }).pipe(
      Effect.provide(
        spawnerLayer().pipe(
          Layer.merge(harnessCatalogLayer),
          Layer.provideMerge(Layer.succeed(HostProcessEnvironment, environment)),
          Layer.provideMerge(Layer.succeed(HostProcessPlatform, "linux")),
        ),
      ),
    );

    yield* adapter.startSession({
      threadId: THREAD_ID,
      cwd: repo,
      runtimeMode: "auto",
      modelSelection: { instanceId: INSTANCE_ID, model: "demo" },
    });

    const collected = yield* Stream.runCollect(
      adapter.streamEvents.pipe(Stream.takeUntil((event) => event.type === "turn.completed")),
    ).pipe(Effect.forkChild);
    yield* Effect.sleep("20 millis");

    // Forked first: `sendTurn` notes which run directories already exist before
    // it spawns, so the run must appear only after that snapshot.
    const turn = yield* adapter
      .sendTurn({
        threadId: THREAD_ID,
        input: "Add a router.",
        modelSelection: { instanceId: INSTANCE_ID, model: "demo" },
      })
      .pipe(Effect.forkChild);
    yield* Effect.sleep("100 millis");
    yield* driveRun({ fileSystem: fs, pathModule, harnessHome, repo });
    yield* Fiber.join(turn);

    const events: ReadonlyArray<ProviderRuntimeEvent> = Array.from(yield* Fiber.join(collected));

    // The node's row goes live: who is working, and on what.
    const progressUpdates = events.filter(
      (event) => event.type === "item.updated" && event.itemId === `harness:${RUN_ID}:step:1`,
    );
    expect(progressUpdates.length).toBeGreaterThan(0);
    const details = progressUpdates.flatMap((event) =>
      event.type === "item.updated" && event.payload.detail !== undefined
        ? [event.payload.detail]
        : [],
    );
    expect(details.at(0)).toContain("builder");
    expect(details.join("\n")).toContain("Edit: /worktrees/demo/src/router.ts");
    const lastUpdate = progressUpdates.at(-1);
    expect(lastUpdate?.type === "item.updated" ? lastUpdate.payload.data : undefined).toMatchObject(
      {
        node: "implement",
        agent: "builder",
        model: "claude-sonnet-4-5",
        provider: "claude",
        toolCalls: 1,
      },
    );

    // The agent's own message and tool call reach the thread.
    const message = events.find(
      (event) =>
        event.type === "item.completed" &&
        event.payload.itemType === "assistant_message" &&
        (event.itemId ?? "").includes(`step:1:msg:`),
    );
    expect(message?.type === "item.completed" && message.payload.detail).toBe(
      "Editing the router.",
    );

    const toolItemId = `harness:${RUN_ID}:step:1:tool:toolu_1`;
    const toolEvents = events.filter((event) => event.itemId === toolItemId);
    expect(toolEvents.map((event) => event.type)).toEqual(["item.started", "item.completed"]);
    expect(toolEvents[0]?.type === "item.started" && toolEvents[0].payload.itemType).toBe(
      "file_change",
    );

    // And it all lands before the node's row closes.
    const nodeClosedAt = events.findIndex(
      (event) => event.type === "item.completed" && event.itemId === `harness:${RUN_ID}:step:1`,
    );
    expect(nodeClosedAt).toBeGreaterThan(events.indexOf(toolEvents.at(-1)!));

    const completed = events.at(-1)!;
    expect(completed.type === "turn.completed" && completed.payload.state).toBe("completed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("watches a Claude node through the CLI transcript, which is the only live file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathModule = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-live-home-" });
    const repo = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-live-repo-" });
    const harnessHome = pathModule.join(home, ".local", "share", "agent-harness");
    yield* fs.makeDirectory(harnessHome, { recursive: true });
    yield* fs.writeFileString(pathModule.join(repo, ".agent-harness.toml"), CONFIG);

    const binPath = pathModule.join(home, "agent-harness");
    yield* fs.writeFileString(binPath, "#!/bin/sh\nexit 0\n");
    yield* fs.chmod(binPath, 0o755);

    // Named after the node's cwd, the way the CLI names it, and keyed by the
    // session the harness pinned in `command.json`.
    const transcript = pathModule.join(
      home,
      ".claude",
      "projects",
      "-worktrees-demo",
      `${SESSION_ID}.jsonl`,
    );

    const environment = isolatedEnvironment(pathModule, home);
    const adapter = yield* makeHarnessAdapter({
      workflows: ["demo"],
      binPath,
      harnessHome,
      environment,
      instanceId: INSTANCE_ID,
    }).pipe(
      Effect.provide(
        spawnerLayer().pipe(
          Layer.merge(harnessCatalogLayer),
          Layer.provideMerge(Layer.succeed(HostProcessEnvironment, environment)),
          Layer.provideMerge(Layer.succeed(HostProcessPlatform, "linux")),
        ),
      ),
    );

    yield* adapter.startSession({
      threadId: THREAD_ID,
      cwd: repo,
      runtimeMode: "auto",
      modelSelection: { instanceId: INSTANCE_ID, model: "demo" },
    });

    const collected = yield* Stream.runCollect(
      adapter.streamEvents.pipe(Stream.takeUntil((event) => event.type === "turn.completed")),
    ).pipe(Effect.forkChild);
    yield* Effect.sleep("20 millis");

    const turn = yield* adapter
      .sendTurn({
        threadId: THREAD_ID,
        input: "Add a router.",
        modelSelection: { instanceId: INSTANCE_ID, model: "demo" },
      })
      .pipe(Effect.forkChild);
    yield* Effect.sleep("100 millis");
    yield* driveRun({
      fileSystem: fs,
      pathModule,
      harnessHome,
      repo,
      agentStreamPath: transcript,
      stepEventsAtEnd: true,
    });
    yield* Fiber.join(turn);

    const events: ReadonlyArray<ProviderRuntimeEvent> = Array.from(yield* Fiber.join(collected));

    // The node's row goes live off the transcript alone: `events.jsonl` did not
    // exist for any of the time the node was open.
    const progressUpdates = events.filter(
      (event) => event.type === "item.updated" && event.itemId === `harness:${RUN_ID}:step:1`,
    );
    const details = progressUpdates.flatMap((event) =>
      event.type === "item.updated" && event.payload.detail !== undefined
        ? [event.payload.detail]
        : [],
    );
    expect(details.join("\n")).toContain("Edit: /worktrees/demo/src/router.ts");

    // Exactly once: the same stream is in both files by the end, and adopting
    // the transcript has to mean the step never reads the other one.
    const messages = events.filter(
      (event) =>
        event.type === "item.completed" &&
        event.payload.itemType === "assistant_message" &&
        (event.itemId ?? "").includes("step:1:msg:"),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.type === "item.completed" && messages[0].payload.detail).toBe(
      "Editing the router.",
    );

    const toolEvents = events.filter(
      (event) => event.itemId === `harness:${RUN_ID}:step:1:tool:toolu_1`,
    );
    expect(toolEvents.map((event) => event.type)).toEqual(["item.started", "item.completed"]);

    const completed = events.at(-1)!;
    expect(completed.type === "turn.completed" && completed.payload.state).toBe("completed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
