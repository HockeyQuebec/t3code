import { DICTATION_LIVE_OVERLAP_SECS } from "@t3tools/contracts";

/**
 * Capturing microphone audio for dictation, and preparing it for Whisper.
 *
 * Everything here is browser-side and deliberately free of React: a recorder
 * whose lifetime is a held button is easier to reason about as a handle than as
 * a tree of effects, and the audio maths below is worth being able to test on
 * its own.
 */

/** Whisper consumes 16 kHz mono; sending more samples than that buys nothing. */
const WHISPER_SAMPLE_RATE = 16_000;

export interface RecordingHandle {
  /** Ends the recording and resolves the tail — the audio since the last segment. */
  readonly stop: () => Promise<Blob | null>;
  /** Ends the recording and throws the audio away. */
  readonly cancel: () => void;
}

export interface StartRecordingOptions {
  /**
   * Called with each whole segment as it closes, while the speaker is still
   * going. Omit for a single clip delivered at `stop()`.
   */
  readonly onSegment?: ((clip: Blob) => void) | undefined;
  readonly segmentSeconds?: number | undefined;
}

export class MicrophoneUnavailableError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message || cause.name : String(cause);
    super(`No microphone available: ${detail}`);
    this.name = "MicrophoneUnavailableError";
  }
}

/** One MediaRecorder pass over an already-open stream. */
function recordSegment(stream: MediaStream): {
  readonly clip: Promise<Blob>;
  readonly halt: () => void;
} {
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const clip = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: chunks[0]?.type || "audio/webm" }));
  });
  recorder.start();
  return {
    clip,
    halt: () => {
      if (recorder.state !== "inactive") recorder.stop();
    },
  };
}

/**
 * Begin recording. Resolves to a handle whose `stop()` returns the tail clip.
 *
 * With `onSegment` and an interval the recording is cut into whole short clips
 * as it goes, each handed over the moment it closes — that is what dictation
 * transcribes while you are still speaking.
 *
 * Segments are separate recordings rather than a growing prefix of one because
 * a recorder cannot produce a decodable partial file: an MPEG-4 gets its index
 * written at stop, and re-decoding an ever-longer WebM prefix would cost more
 * whisper time on every pass. The caller prepends the prior segment's last
 * second before transcribing, so words crossing a cut survive.
 */
export async function startRecording(
  options: StartRecordingOptions = {},
): Promise<RecordingHandle> {
  const { onSegment, segmentSeconds } = options;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new MicrophoneUnavailableError(
      new Error("this view has no microphone API — open T3 Code in a browser or the desktop app"),
    );
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (cause) {
    // A browser only exposes the mic on a secure origin; 127.0.0.1 counts.
    throw new MicrophoneUnavailableError(cause);
  }

  const segmentMs =
    onSegment && segmentSeconds && segmentSeconds > 0 ? Math.round(segmentSeconds * 1000) : 0;
  let current = recordSegment(stream);
  let timer: ReturnType<typeof setInterval> | null = null;

  const close = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    for (const track of stream.getTracks()) track.stop();
  };

  if (segmentMs > 0 && onSegment) {
    timer = setInterval(() => {
      const finished = current;
      // Open the next recorder before closing this one: the mic stays open
      // either way, so the gap is a turn of the event loop.
      current = recordSegment(stream);
      finished.halt();
      void finished.clip.then((clip) => {
        if (clip.size > 0) onSegment(clip);
      });
    }, segmentMs);
  }

  return {
    async stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      current.halt();
      const clip = await current.clip;
      close();
      return clip;
    },
    cancel() {
      current.halt();
      close();
    },
  };
}

/** Encode mono floating-point samples as the plain PCM WAV Whisper handles best. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Downmix an AudioBuffer into mono, optionally starting partway through it. */
export function monoSamples(buffer: AudioBuffer, start = 0): Float32Array {
  const samples = new Float32Array(Math.max(0, buffer.length - start));
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const input = buffer.getChannelData(channel);
    for (let i = start; i < buffer.length; i++) {
      samples[i - start]! += input[i]! / buffer.numberOfChannels;
    }
  }
  return samples;
}

/**
 * Put the end of `previous` in front of `current`.
 *
 * Recorder clips arrive as complete containers, so concatenating their bytes
 * would not make valid audio. Decode both, take the useful tail, and emit one
 * 16 kHz mono WAV. If this browser cannot decode a recorder format the
 * untouched clip is returned — a segment without its overlap still transcribes,
 * it just risks clipping the word on the seam.
 */
export async function withAudioOverlap(
  previous: Blob | null,
  current: Blob,
  seconds: number = DICTATION_LIVE_OVERLAP_SECS,
): Promise<Blob> {
  const OfflineContext =
    window.OfflineAudioContext ??
    (window as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  if (!OfflineContext || previous === null) return current;
  try {
    const context = new OfflineContext(1, WHISPER_SAMPLE_RATE, WHISPER_SAMPLE_RATE);
    // Decode serially: WebKit's OfflineAudioContext is unhappy decoding two
    // compressed inputs on the same context at once.
    const prior = await context.decodeAudioData(await previous.arrayBuffer());
    const next = await context.decodeAudioData(await current.arrayBuffer());
    const overlapFrames = Math.min(prior.length, Math.round(seconds * prior.sampleRate));
    if (overlapFrames === 0) return current;
    const tail = monoSamples(prior, prior.length - overlapFrames);
    const body = monoSamples(next);
    const joined = new Float32Array(tail.length + body.length);
    joined.set(tail);
    joined.set(body, tail.length);
    return encodeWav(joined, prior.sampleRate);
  } catch {
    return current;
  }
}

/** The wire form: the RPC carries base64, not a Blob. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // Chunked so a long clip cannot blow the argument limit of `String.fromCharCode`.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
