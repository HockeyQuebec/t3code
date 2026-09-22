/**
 * What happens to a harness run whose turn is abandoned.
 *
 * `sendTurn` holds the run for the whole time the process is up, so anything
 * that takes that fiber away — a cancelled turn, a dropped caller — used to
 * leave the run behind and make the thread refuse every later turn with
 * "A harness run is already in flight for this thread."
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
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vite-plus/test";

import { layer as harnessCatalogLayer } from "../../harness/HarnessCatalog.ts";
import { makeHarnessAdapter } from "./HarnessAdapter.ts";

const encoder = new TextEncoder();

const THREAD_ID = ThreadId.make("thread-harness-lifecycle");
const INSTANCE_ID = ProviderInstanceId.make("harness");

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

const isolatedEnvironment = (pathModule: Path.Path, home: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  XDG_CONFIG_HOME: pathModule.join(home, ".config"),
  AGENT_HARNESS_HOME: pathModule.join(home, ".local", "share", "agent-harness"),
});

/**
 * The first spawn never exits — that is the run the test walks away from. Every
 * later spawn exits straight away, so a turn that gets through reports quickly.
 */
function spawnerLayer(spawns: Ref.Ref<number>) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        const nth = yield* Ref.getAndUpdate(spawns, (count) => count + 1);
        const alive = nth === 0;
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1000 + nth),
          exitCode: alive ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          isRunning: Effect.succeed(alive),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode("")),
          stderr: Stream.make(encoder.encode("")),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );
}

it.live("lets a thread take a new turn after the previous one was abandoned", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathModule = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-life-home-" });
    const repo = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-life-repo-" });
    const harnessHome = pathModule.join(home, ".local", "share", "agent-harness");
    yield* fs.makeDirectory(harnessHome, { recursive: true });
    yield* fs.writeFileString(pathModule.join(repo, ".agent-harness.toml"), CONFIG);

    const binPath = pathModule.join(home, "agent-harness");
    yield* fs.writeFileString(binPath, "#!/bin/sh\nexit 0\n");
    yield* fs.chmod(binPath, 0o755);

    const spawns = yield* Ref.make(0);
    const environment = isolatedEnvironment(pathModule, home);
    const adapter = yield* makeHarnessAdapter({
      workflows: ["demo"],
      binPath,
      harnessHome,
      environment,
      instanceId: INSTANCE_ID,
    }).pipe(
      Effect.provide(
        spawnerLayer(spawns).pipe(
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

    const abandoned = yield* adapter
      .sendTurn({
        threadId: THREAD_ID,
        input: "Add a router.",
        modelSelection: { instanceId: INSTANCE_ID, model: "demo" },
      })
      .pipe(Effect.forkChild);
    yield* Effect.sleep("200 millis");
    yield* Fiber.interrupt(abandoned);

    const events: Array<ProviderRuntimeEvent> = [];
    const collected = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    ).pipe(Effect.forkChild);
    yield* Effect.sleep("20 millis");

    // The thread is free again: the run went away with the turn that held it.
    const next = yield* adapter.sendTurn({
      threadId: THREAD_ID,
      input: "Try again.",
      modelSelection: { instanceId: INSTANCE_ID, model: "demo" },
    });
    expect(next.threadId).toBe(THREAD_ID);
    expect(yield* Ref.get(spawns)).toBe(2);

    const completed = events.filter(
      (event) => event.type === "turn.completed" && event.turnId === next.turnId,
    );
    expect(completed.length).toBe(1);

    yield* Fiber.interrupt(collected);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
