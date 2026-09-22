import {
  DICTATION_MAX_AUDIO_BYTES,
  DictationError,
  type DictationStatus,
  type TranscribeAudioInput,
  type TranscribeAudioResult,
  dictationAudioExtension,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ffmpegArgs, isFasterWhisper, whisperArgs } from "@t3tools/shared/whisperArgs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

import { ProcessRunner } from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { resolveExecutable } from "./WhisperBinary.ts";

/**
 * Local speech-to-text for the composer.
 *
 * A client records a clip, sends the bytes, and this turns them into text with
 * a Whisper CLI on this machine — nothing leaves the box, which is the whole
 * point of shelling out rather than calling a hosted API.
 */

/** A finished clip is worth waiting for; nobody is watching the box meanwhile. */
const CLIP_TIMEOUT = "5 minutes";

/**
 * A live segment is a few seconds of audio. If it has not decoded by now the
 * speaker is long gone and the answer is no longer worth having.
 */
const LIVE_TIMEOUT = "60 seconds";

export class DictationService extends Context.Service<
  DictationService,
  {
    readonly status: Effect.Effect<DictationStatus>;
    readonly transcribe: (
      input: TranscribeAudioInput,
    ) => Effect.Effect<TranscribeAudioResult, DictationError>;
  }
>()("t3/dictation/Dictation/DictationService") {}

const missingWhisper = (binary: string) =>
  new DictationError({
    reason: "whisperMissing",
    detail:
      `Speech-to-text needs a Whisper CLI: ${binary} was not found. ` +
      "Install one with `pip install whisper-ctranslate2`, or name a different binary in Settings › Dictation.",
  });

/** The CLI's own last line is the most useful thing we can show. */
function failureDetail(output: { readonly stderr: string; readonly stdout: string }): string {
  const lines = (output.stderr || output.stdout || "")
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1) ?? "";
}

const make = Effect.fn("t3/dictation/Dictation/make")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathModule = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const processRunner = yield* ProcessRunner;
  const settingsService = yield* ServerSettingsService;

  const readSettings = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.dictation),
    // Unreadable settings are not something a person holding a mic can fix, and
    // the defaults transcribe perfectly well, so dictation keeps working.
    Effect.orElseSucceed(() => undefined),
  );

  const locate = (name: string) =>
    Effect.gen(function* () {
      const environment = yield* HostProcessEnvironment;
      return yield* resolveExecutable({
        fileSystem,
        pathModule,
        name,
        pathEnv: environment.PATH ?? "",
        home: environment.HOME ?? environment.USERPROFILE,
        platform,
      });
    });

  const status: DictationService["Service"]["status"] = Effect.gen(function* () {
    const settings = yield* readSettings;
    const binary = settings?.binary ?? "whisper-ctranslate2";
    if (settings?.enabled === false) {
      return {
        available: false,
        binary,
        resolvedPath: Option.none(),
        fasterWhisper: false,
        ffmpegAvailable: false,
      } satisfies DictationStatus;
    }
    const [resolved, ffmpeg] = yield* Effect.all([locate(binary), locate("ffmpeg")], {
      concurrency: "unbounded",
    });
    return {
      available: resolved !== null,
      binary,
      resolvedPath: resolved === null ? Option.none() : Option.some(resolved),
      fasterWhisper: resolved !== null && isFasterWhisper(resolved),
      ffmpegAvailable: ffmpeg !== null,
    } satisfies DictationStatus;
  });

  /**
   * Normalise to 16 kHz mono WAV when ffmpeg is around, so the model gets what
   * it expects regardless of which codecs the CLI was built with. Falling back
   * to the original clip is fine — the CLIs decode compressed audio themselves.
   */
  const normalizeAudio = (clipPath: string, workDir: string) =>
    Effect.gen(function* () {
      const ffmpeg = yield* locate("ffmpeg");
      if (ffmpeg === null || clipPath.endsWith(".wav")) {
        return clipPath;
      }
      const wavPath = pathModule.join(workDir, "normalized.wav");
      const result = yield* processRunner
        .run({
          command: ffmpeg,
          args: [...ffmpegArgs({ source: clipPath, destination: wavPath })],
          timeout: LIVE_TIMEOUT,
          outputMode: "truncate",
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (result === null || result.code !== 0) {
        return clipPath;
      }
      const written = yield* fileSystem.exists(wavPath).pipe(Effect.orElseSucceed(() => false));
      return written ? wavPath : clipPath;
    });

  /**
   * Whisper names the transcript after the audio file, but the two front-ends
   * have disagreed about that in the past; any single `.txt` in a directory we
   * own can only have come from this run.
   */
  const readTranscript = (audioPath: string, workDir: string) =>
    Effect.gen(function* () {
      const expected = `${audioPath.replace(/\.[^.]+$/, "")}.txt`;
      const direct = yield* fileSystem
        .readFileString(expected)
        .pipe(Effect.orElseSucceed(() => null));
      if (direct !== null) {
        return direct;
      }
      const entries = yield* fileSystem
        .readDirectory(workDir)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      const produced = entries.filter((entry) => entry.endsWith(".txt")).toSorted();
      const first = produced[0];
      if (first === undefined) {
        return null;
      }
      return yield* fileSystem
        .readFileString(pathModule.join(workDir, first))
        .pipe(Effect.orElseSucceed(() => null));
    });

  const transcribe: DictationService["Service"]["transcribe"] = (input) =>
    Effect.gen(function* () {
      const settings = yield* readSettings;
      if (settings === undefined) {
        return yield* missingWhisper("whisper-ctranslate2");
      }
      if (!settings.enabled) {
        return yield* new DictationError({
          reason: "whisperMissing",
          detail: "Dictation is turned off for this environment.",
        });
      }

      const suffix = dictationAudioExtension(input.mimeType);
      if (suffix === undefined) {
        return yield* new DictationError({
          reason: "unsupportedAudioType",
          detail: `Unsupported audio type: ${input.mimeType || "none"}`,
        });
      }

      const audio = Buffer.from(input.audioBase64, "base64");
      if (audio.byteLength === 0) {
        return { text: "" } satisfies TranscribeAudioResult;
      }
      if (audio.byteLength > DICTATION_MAX_AUDIO_BYTES) {
        return yield* new DictationError({
          reason: "audioTooLarge",
          detail: `Recording is larger than ${Math.round(DICTATION_MAX_AUDIO_BYTES / (1024 * 1024))}MB.`,
        });
      }

      const binaryPath = yield* locate(settings.binary);
      if (binaryPath === null) {
        return yield* missingWhisper(settings.binary);
      }

      return yield* Effect.gen(function* () {
        const workDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dictation-" }).pipe(
          Effect.mapError(
            (cause) =>
              new DictationError({
                reason: "decodeFailed",
                detail: `Could not open a working directory for transcription: ${cause}`,
              }),
          ),
        );
        const clipPath = pathModule.join(workDir, `clip${suffix}`);
        yield* fileSystem.writeFile(clipPath, audio).pipe(
          Effect.mapError(
            (cause) =>
              new DictationError({
                reason: "decodeFailed",
                detail: `Could not write the recording to disk: ${cause}`,
              }),
          ),
        );

        const audioPath = yield* normalizeAudio(clipPath, workDir);
        const cpuCount = yield* Effect.sync(() => NodeOS.availableParallelism());
        const result = yield* processRunner
          .run({
            command: binaryPath,
            args: [
              ...whisperArgs({
                binaryPath,
                audioPath,
                outputDir: workDir,
                settings,
                live: input.live,
                cpuCount,
              }),
            ],
            timeout: input.live ? LIVE_TIMEOUT : CLIP_TIMEOUT,
            timeoutBehavior: "timedOutResult",
            outputMode: "truncate",
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new DictationError({
                  reason: "decodeFailed",
                  detail: `Could not run ${binaryPath}: ${cause}`,
                }),
            ),
          );

        if (result.timedOut) {
          return yield* new DictationError({
            reason: "timedOut",
            detail: "Transcription timed out.",
          });
        }
        if (result.code !== 0) {
          const detail = failureDetail(result);
          return yield* new DictationError({
            reason: "decodeFailed",
            detail: detail.length > 0 ? detail : `Whisper exited with code ${result.code}.`,
          });
        }

        const transcript = yield* readTranscript(audioPath, workDir);
        if (transcript === null) {
          return yield* new DictationError({
            reason: "decodeFailed",
            detail: "Whisper produced no transcript.",
          });
        }
        return { text: transcript.trim() } satisfies TranscribeAudioResult;
      }).pipe(Effect.scoped);
    });

  return DictationService.of({ status, transcribe });
});

export const layer = Layer.effect(DictationService, make());
