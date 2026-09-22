import type { DictationSettings } from "@t3tools/contracts";

/**
 * The argv that drives a Whisper CLI, and the small number of decisions that
 * decide how long a decode takes.
 *
 * Kept separate from the service that spawns the process because every
 * interesting choice here is a pure function of the settings and one boolean,
 * and none of it needs a machine with whisper installed to check.
 */

/**
 * More threads than this stops helping and starts fighting the scheduler on a
 * machine that is also running agents.
 */
const MAX_THREADS = 8;

/** Is this the ctranslate2 front-end, which takes the quantisation flags? */
export function isFasterWhisper(binaryPath: string): boolean {
  const name = binaryPath.split(/[\\/]/).pop() ?? binaryPath;
  return name.includes("ctranslate2");
}

/**
 * Flags that decide how long the decode takes.
 *
 * Live segments always take the fast path regardless of the setting — a partial
 * that arrives after you stopped talking is no use to anyone, however accurate.
 */
export function decodeArgs(input: {
  readonly binaryPath: string;
  readonly settings: DictationSettings;
  readonly live: boolean;
  readonly cpuCount: number;
}): ReadonlyArray<string> {
  if (!(input.live || input.settings.fast)) {
    return [];
  }
  const threads = Math.max(1, Math.min(input.cpuCount || 4, MAX_THREADS));
  const args = [
    "--beam_size",
    "1",
    "--best_of",
    "1",
    // Each clip is its own utterance. Carrying context across them costs time
    // and invites the model to loop on a repeated phrase.
    "--condition_on_previous_text",
    "False",
    "--threads",
    String(threads),
  ];
  if (isFasterWhisper(input.binaryPath)) {
    args.push(
      "--compute_type",
      input.settings.computeType,
      // Silence is most of a push-to-talk clip; not decoding it is the single
      // biggest win available here.
      "--vad_filter",
      "True",
    );
  }
  return args;
}

/**
 * `--task` and `--language`, which together decide what comes back.
 *
 * Whisper's `translate` task only ever emits English, so pinning the source
 * language to English would ask it to translate English into English. When
 * translating we let it detect the language instead, unless the user named a
 * different one.
 */
export function taskArgs(settings: DictationSettings): ReadonlyArray<string> {
  const task = settings.translate ? "translate" : "transcribe";
  const args = ["--task", task];
  const requested = settings.language.trim();
  const language =
    task === "translate" && ["en", "english"].includes(requested.toLowerCase()) ? "" : requested;
  if (language.length > 0) {
    args.push("--language", language);
  }
  return args;
}

/** The model a clip decodes with. Live segments may use a smaller one. */
export function modelForClip(settings: DictationSettings, live: boolean): string {
  return live && settings.liveModel.length > 0 ? settings.liveModel : settings.model;
}

/** The complete argv, in the order the CLIs document it. */
export function whisperArgs(input: {
  readonly binaryPath: string;
  readonly audioPath: string;
  readonly outputDir: string;
  readonly settings: DictationSettings;
  readonly live: boolean;
  readonly cpuCount: number;
}): ReadonlyArray<string> {
  return [
    input.audioPath,
    "--model",
    modelForClip(input.settings, input.live),
    "--output_dir",
    input.outputDir,
    "--output_format",
    "txt",
    ...taskArgs(input.settings),
    ...decodeArgs({
      binaryPath: input.binaryPath,
      settings: input.settings,
      live: input.live,
      cpuCount: input.cpuCount,
    }),
  ];
}

/**
 * Down-convert to 16 kHz mono WAV so the model gets what it expects.
 *
 * Only used when ffmpeg is present. The Whisper CLIs decode compressed audio on
 * their own; this just avoids depending on which codecs they were built with.
 */
export function ffmpegArgs(input: {
  readonly source: string;
  readonly destination: string;
}): ReadonlyArray<string> {
  return ["-nostdin", "-y", "-i", input.source, "-ac", "1", "-ar", "16000", input.destination];
}
