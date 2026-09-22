import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Dictation: speech typed into the composer by a Whisper CLI on the environment
 * that would run the agent. The audio is posted to that machine, decoded there,
 * and the text comes back — nothing is sent to a hosted transcription service,
 * which is the whole reason this is a local CLI shellout rather than an API.
 *
 * Both supported front-ends — `whisper-ctranslate2` (faster-whisper) and
 * OpenAI's `whisper` — take the same `--model / --output_dir / --output_format`
 * flags, so a single argv drives either.
 */

/**
 * What a recorder can hand us, and the extension the decoder needs in order to
 * pick the right demuxer. A clip's bytes alone do not tell the CLI what it is
 * looking at; the filename does.
 */
export const DICTATION_AUDIO_EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
};

/** Codec parameters ride along on a MediaRecorder mime type; strip them first. */
export function dictationAudioExtension(mimeType: string): string | undefined {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return DICTATION_AUDIO_EXTENSIONS[base];
}

/**
 * Ceiling on one clip. A live segment is a few seconds and nowhere near this;
 * the limit exists for a latched recording nobody stopped, and matches the
 * image-attachment ceiling so one oversized upload cannot behave differently
 * depending on which control produced it.
 */
export const DICTATION_MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/** Base64 inflates by 4/3, plus the data-url preamble. */
export const DICTATION_MAX_AUDIO_BASE64_CHARS = 14_000_000;

/** Whisper sizes, fastest first. The one dial that really decides latency. */
export const WHISPER_MODEL_CHOICES = ["tiny", "base", "small", "medium", "large-v3"] as const;

/** faster-whisper quantisations, fastest first. Ignored by OpenAI's whisper. */
export const WHISPER_COMPUTE_CHOICES = ["int8", "int8_float32", "float16", "float32"] as const;

/** Seconds of new speech per live segment, as offered by the settings form. */
export const DICTATION_LIVE_SECS_RANGE = { minimum: 2, maximum: 30 } as const;

/**
 * Audio repeated across live segment boundaries so a word spoken across the cut
 * is heard whole by at least one segment. The transcripts are reconciled after
 * the fact, so the repeat costs a little decode time and nothing else.
 */
export const DICTATION_LIVE_OVERLAP_SECS = 1;

export const WhisperModel = Schema.Literals(WHISPER_MODEL_CHOICES);
export type WhisperModel = typeof WhisperModel.Type;

export const WhisperComputeType = Schema.Literals(WHISPER_COMPUTE_CHOICES);
export type WhisperComputeType = typeof WhisperComputeType.Type;

export const TranscribeAudioInput = Schema.Struct({
  /** The clip, base64-encoded. Sent inline for the same reason images are. */
  audioBase64: TrimmedNonEmptyString.check(Schema.isMaxLength(DICTATION_MAX_AUDIO_BASE64_CHARS)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  /**
   * A segment handed over mid-sentence while the speaker is still going, rather
   * than a finished clip. Live segments always decode fast and may use a
   * smaller model: a partial that arrives after you stopped talking is no use
   * to anyone, however accurate it is.
   */
  live: Schema.Boolean,
});
export type TranscribeAudioInput = typeof TranscribeAudioInput.Type;

export const TranscribeAudioResult = Schema.Struct({
  /** Empty is a normal answer — silence, or a segment that was all breath. */
  text: Schema.String,
});
export type TranscribeAudioResult = typeof TranscribeAudioResult.Type;

/**
 * Why a clip produced no text. Each of these is something the person holding
 * the mic can act on, which is why they are failures rather than empty results.
 */
export const DictationFailureReason = Schema.Literals([
  "whisperMissing",
  "unsupportedAudioType",
  "audioTooLarge",
  "timedOut",
  "decodeFailed",
]);
export type DictationFailureReason = typeof DictationFailureReason.Type;

export class DictationError extends Schema.TaggedErrorClass<DictationError>()("DictationError", {
  reason: DictationFailureReason,
  /** Ready to show: the CLI's own last line where there is one. */
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Whether this environment can transcribe at all, so a client can hide the mic
 * instead of offering a button that always fails.
 */
export const DictationStatus = Schema.Struct({
  available: Schema.Boolean,
  /** The configured binary name, echoed back so an error can name it. */
  binary: TrimmedNonEmptyString,
  resolvedPath: Schema.Option(TrimmedNonEmptyString),
  /** ctranslate2 front-end, which is the one that reads the quantisation flags. */
  fasterWhisper: Schema.Boolean,
  /** Whether ffmpeg is around to normalise clips before they reach the model. */
  ffmpegAvailable: Schema.Boolean,
});
export type DictationStatus = typeof DictationStatus.Type;
