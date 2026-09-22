import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";

import { ProcessRunner, type ProcessRunOutput } from "../processRunner.ts";
import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import { DictationService, layer } from "./Dictation.ts";
import { expandHome, resolveExecutable } from "./WhisperBinary.ts";

/**
 * These tests never run whisper. What is worth pinning down is the argv we
 * build, the file we hand it, and how each failure reads back to the person
 * holding the mic — none of which needs the CLI to be installed, and all of
 * which would otherwise depend on whether the developer happens to have it.
 */

interface Invocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const ok = (overrides: Partial<ProcessRunOutput> = {}): ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: 0 as ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
});

const stubRunner = (
  onRun: (invocation: Invocation) => Effect.Effect<ProcessRunOutput>,
  record?: Array<Invocation>,
) =>
  Layer.mock(ProcessRunner)({
    run: (input) => {
      const invocation = { command: input.command, args: input.args };
      record?.push(invocation);
      return onRun(invocation);
    },
  });

/** A directory holding an executable named like the CLI we are pretending to find. */
const fakeBinDir = (name: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathModule = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dictation-bin-" });
    const executable = pathModule.join(dir, name);
    yield* fileSystem.writeFileString(executable, "#!/bin/sh\nexit 0\n");
    yield* fileSystem.chmod(executable, 0o755);
    return { dir, executable };
  });

/**
 * `PATH` is pinned to directories the test owns. Left to the real environment,
 * every one of these assertions would flip on a machine that happens to have
 * whisper or ffmpeg installed.
 */
const isolated = (dirs: ReadonlyArray<string>): NodeJS.ProcessEnv => ({
  PATH: dirs.join(":"),
  HOME: "/nonexistent",
});

const withService = <A, E>(
  effect: Effect.Effect<A, E, DictationService | FileSystem.FileSystem | Path.Path>,
  options: {
    readonly runner: Layer.Layer<ProcessRunner>;
    readonly pathDirs: ReadonlyArray<string>;
    readonly settings?: Parameters<typeof serverSettingsLayerTest>[0];
  },
) =>
  effect.pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(options.runner),
        Layer.provide(serverSettingsLayerTest(options.settings ?? {})),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.provideService(HostProcessEnvironment, isolated(options.pathDirs)),
  );

it.effect("expands a home-relative binary path", () =>
  Effect.sync(() => {
    assert.strictEqual(expandHome("~/venv/bin/whisper", "/Users/x"), "/Users/x/venv/bin/whisper");
    assert.strictEqual(expandHome("~", "/Users/x"), "/Users/x");
    assert.strictEqual(expandHome("whisper", "/Users/x"), "whisper");
    assert.strictEqual(expandHome("~/bin/whisper", undefined), "~/bin/whisper");
  }),
);

it.effect("never falls back to PATH for a name that looks like a path", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathModule = yield* Path.Path;
    const { dir } = yield* fakeBinDir("whisper-ctranslate2");

    assert.isNotNull(
      yield* resolveExecutable({
        fileSystem,
        pathModule,
        name: "whisper-ctranslate2",
        pathEnv: dir,
        platform: "darwin",
      }),
    );
    // A typo'd path must not silently resolve to some unrelated binary on PATH
    // that happens to share a basename.
    assert.isNull(
      yield* resolveExecutable({
        fileSystem,
        pathModule,
        name: "/nowhere/whisper-ctranslate2",
        pathEnv: dir,
        platform: "darwin",
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("reports unavailable, and names the binary, when no whisper is installed", () =>
  withService(
    Effect.gen(function* () {
      const dictation = yield* DictationService;

      const status = yield* dictation.status;
      assert.isFalse(status.available);
      assert.strictEqual(status.binary, "whisper-ctranslate2");
      assert.isTrue(Option.isNone(status.resolvedPath));

      const error = yield* dictation
        .transcribe({
          audioBase64: Buffer.from("clip").toString("base64"),
          mimeType: "audio/webm",
          live: false,
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "whisperMissing");
      assert.include(error.detail, "whisper-ctranslate2");
    }),
    { runner: stubRunner(() => Effect.die("no process should be spawned")), pathDirs: [] },
  ).pipe(Effect.scoped),
);

it.effect("reports unavailable without probing PATH when dictation is turned off", () =>
  Effect.gen(function* () {
    const { dir } = yield* fakeBinDir("whisper-ctranslate2");
    const status = yield* withService(
      Effect.flatMap(DictationService, (dictation) => dictation.status),
      {
        runner: stubRunner(() => Effect.die("no process should be spawned")),
        pathDirs: [dir],
        settings: { dictation: { enabled: false } },
      },
    );
    assert.isFalse(status.available);
    assert.isTrue(Option.isNone(status.resolvedPath));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("rejects an audio type no decoder can demux", () =>
  withService(
    Effect.gen(function* () {
      const dictation = yield* DictationService;
      const error = yield* dictation
        .transcribe({ audioBase64: "AAAA", mimeType: "audio/aiff", live: false })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "unsupportedAudioType");
    }),
    { runner: stubRunner(() => Effect.die("no process should be spawned")), pathDirs: [] },
  ).pipe(Effect.scoped),
);

it.effect("runs whisper on the clip and returns the transcript it wrote", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathModule = yield* Path.Path;
    const { dir, executable } = yield* fakeBinDir("whisper-ctranslate2");
    const invocations: Array<Invocation> = [];

    const result = yield* withService(
      Effect.flatMap(DictationService, (dictation) =>
        dictation.transcribe({
          audioBase64: Buffer.from("clip").toString("base64"),
          mimeType: "audio/webm",
          live: false,
        }),
      ),
      {
        runner: stubRunner((invocation) => {
          // Stand in for the CLI: write the transcript where it would.
          const outputDir = invocation.args[invocation.args.indexOf("--output_dir") + 1]!;
          const audio = invocation.args[0]!;
          const transcript = pathModule.join(
            outputDir,
            `${pathModule.basename(audio).replace(/\.[^.]+$/, "")}.txt`,
          );
          return fileSystem
            .writeFileString(transcript, "  run the tests  \n")
            .pipe(Effect.orDie, Effect.as(ok()));
        }, invocations),
        pathDirs: [dir],
      },
    );

    assert.strictEqual(result.text, "run the tests");
    assert.lengthOf(invocations, 1);
    const [invocation] = invocations;
    assert.strictEqual(invocation!.command, executable);
    // The default settings ask for a fast English transcription on `small`.
    assert.deepInclude(invocation!.args, "--model");
    assert.strictEqual(invocation!.args[invocation!.args.indexOf("--model") + 1], "small");
    assert.strictEqual(invocation!.args[invocation!.args.indexOf("--task") + 1], "transcribe");
    assert.include(invocation!.args, "--vad_filter");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("uses the smaller live model for a segment handed over mid-sentence", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathModule = yield* Path.Path;
    const { dir } = yield* fakeBinDir("whisper-ctranslate2");
    const invocations: Array<Invocation> = [];

    yield* withService(
      Effect.flatMap(DictationService, (dictation) =>
        dictation.transcribe({
          audioBase64: Buffer.from("clip").toString("base64"),
          mimeType: "audio/wav",
          live: true,
        }),
      ),
      {
        runner: stubRunner((invocation) => {
          const outputDir = invocation.args[invocation.args.indexOf("--output_dir") + 1]!;
          const audio = invocation.args[0]!;
          return fileSystem
            .writeFileString(
              pathModule.join(
                outputDir,
                `${pathModule.basename(audio).replace(/\.[^.]+$/, "")}.txt`,
              ),
              "partial",
            )
            .pipe(Effect.orDie, Effect.as(ok()));
        }, invocations),
        pathDirs: [dir],
        settings: { dictation: { model: "medium", liveModel: "tiny", fast: false } },
      },
    );

    const [invocation] = invocations;
    assert.strictEqual(invocation!.args[invocation!.args.indexOf("--model") + 1], "tiny");
    // Live always decodes fast, whatever the setting says.
    assert.include(invocation!.args, "--beam_size");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("surfaces the CLI's last line when it exits non-zero", () =>
  Effect.gen(function* () {
    const { dir } = yield* fakeBinDir("whisper-ctranslate2");
    const error = yield* withService(
      Effect.flatMap(DictationService, (dictation) =>
        dictation
          .transcribe({
            audioBase64: Buffer.from("clip").toString("base64"),
            mimeType: "audio/webm",
            live: false,
          })
          .pipe(Effect.flip),
      ),
      {
        runner: stubRunner(() =>
          Effect.succeed(
            ok({
              code: 1 as ProcessRunOutput["code"],
              stderr: "loading model\nRuntimeError: model 'small' could not be downloaded\n",
            }),
          ),
        ),
        pathDirs: [dir],
      },
    );
    assert.strictEqual(error.reason, "decodeFailed");
    assert.strictEqual(error.detail, "RuntimeError: model 'small' could not be downloaded");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("says a decode timed out rather than reporting silence", () =>
  Effect.gen(function* () {
    const { dir } = yield* fakeBinDir("whisper-ctranslate2");
    const error = yield* withService(
      Effect.flatMap(DictationService, (dictation) =>
        dictation
          .transcribe({
            audioBase64: Buffer.from("clip").toString("base64"),
            mimeType: "audio/webm",
            live: true,
          })
          .pipe(Effect.flip),
      ),
      {
        runner: stubRunner(() => Effect.succeed(ok({ code: null, timedOut: true }))),
        pathDirs: [dir],
      },
    );
    assert.strictEqual(error.reason, "timedOut");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("treats an empty clip as silence rather than an error", () =>
  withService(
    Effect.gen(function* () {
      const dictation = yield* DictationService;
      const result = yield* dictation.transcribe({
        audioBase64: "  ",
        mimeType: "audio/webm",
        live: true,
      });
      assert.strictEqual(result.text, "");
    }),
    { runner: stubRunner(() => Effect.die("no process should be spawned")), pathDirs: [] },
  ).pipe(Effect.scoped),
);
