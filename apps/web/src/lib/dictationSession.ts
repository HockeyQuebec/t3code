import { joinDictationPrefix, mergeTranscript } from "@t3tools/shared/dictationTranscript";

import {
  MicrophoneUnavailableError,
  blobToBase64,
  startRecording,
  withAudioOverlap,
  type RecordingHandle,
} from "./dictationAudio";

/**
 * One dictation: from the moment the mic opens to the moment the last segment's
 * text lands in the composer.
 *
 * This is deliberately a plain object rather than a hook. A recording outlives
 * renders, has to survive the component re-rendering as text streams in, and
 * every interesting rule in it — clips transcribe strictly in order, an edit
 * made while whisper was catching up is never overwritten — is easier to state
 * against explicit state than against a pile of refs.
 */

export interface DictationSessionOptions {
  /** Transcribe one clip. Rejects with something worth showing the speaker. */
  readonly transcribe: (input: {
    readonly audioBase64: string;
    readonly mimeType: string;
    readonly live: boolean;
  }) => Promise<string>;
  /** The composer text when the recording started, and where to put the result. */
  readonly readPrompt: () => string;
  /**
   * Replace the span this dictation owns with `text`. `expected` is what the
   * session last wrote there: when it no longer matches, the user edited it and
   * the session must start a fresh span rather than clobber their version.
   */
  readonly writeTranscript: (input: {
    readonly text: string;
    readonly rangeStart: number;
    readonly rangeEnd: number;
    readonly expected: string;
    /**
     * True while the speaker is still going. The composer uses this to leave
     * focus alone mid-dictation and only place the caret once at the end.
     */
    readonly live: boolean;
  }) => boolean;
  readonly onStateChange: (state: DictationSessionState) => void;
  readonly live: boolean;
  readonly liveSegmentSeconds: number;
  /**
   * How to open the microphone. Injectable so the ordering and edit-preservation
   * rules can be tested without a real audio device, which no test runner has.
   */
  readonly openRecorder?: typeof startRecording;
  /**
   * How to prepare a live segment for transcription. The default prepends the
   * prior segment's last second; tests substitute the identity.
   */
  readonly overlapAudio?: typeof withAudioOverlap;
  /** Blob → base64. Injectable for the same reason. */
  readonly encodeAudio?: typeof blobToBase64;
}

export interface DictationSessionState {
  readonly phase: "idle" | "starting" | "recording" | "transcribing";
  /** True once a quick tap latched recording on, so a hold is not required. */
  readonly latched: boolean;
  /** Seconds recorded so far, for the timer under the button. */
  readonly elapsedSeconds: number;
  /** Clips still decoding. Non-zero means text is still on its way. */
  readonly inflight: number;
  readonly error: string | null;
}

const IDLE: DictationSessionState = {
  phase: "idle",
  latched: false,
  elapsedSeconds: 0,
  inflight: 0,
  error: null,
};

/** A press shorter than this latches recording on instead of ending it. */
export const TAP_MS = 350;

/** Space must be held this long before keyboard push-to-talk begins. */
export const SPACE_HOLD_MS = 500;

export class DictationSession {
  #options: DictationSessionOptions;
  #state: DictationSessionState = IDLE;
  #handle: RecordingHandle | null = null;
  #starting = false;
  #releasedWhileStarting = false;
  #startedAt = 0;
  #ticker: ReturnType<typeof setInterval> | null = null;

  /** Clips transcribe one at a time so the sentence assembles in order. */
  #queue: Promise<unknown> = Promise.resolve();
  #previousClip: Blob | null = null;
  /** Whether any clip in this recording produced words, for the silence message. */
  #delivered = 0;

  /** The composer text before this dictation, and the span it has written. */
  #prefix = "";
  #transcript = "";
  #rangeStart = 0;
  /** Exactly what this session last wrote at `#rangeStart`, separator included. */
  #renderedSpan = "";

  constructor(options: DictationSessionOptions) {
    this.#options = options;
  }

  /** Settings are read when a recording starts, so a change applies next press. */
  configure(options: Partial<DictationSessionOptions>): void {
    this.#options = { ...this.#options, ...options };
  }

  get state(): DictationSessionState {
    return this.#state;
  }

  get isRecording(): boolean {
    return this.#handle !== null || this.#starting;
  }

  #setState(patch: Partial<DictationSessionState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#options.onStateChange(this.#state);
  }

  /**
   * Put a transcript in the composer.
   *
   * If the user edited while whisper was catching up, their version wins and a
   * fresh span begins after it — the alternative is silently reverting an edit
   * a second or two after it was made, which is far worse than a duplicated
   * word.
   */
  #append(text: string, live: boolean): void {
    if (text.length === 0) return;
    this.#delivered += 1;

    const merged = mergeTranscript(this.#transcript, text);
    const span = joinDictationPrefix(this.#prefix, merged).slice(this.#rangeStart);
    const replaced = this.#options.writeTranscript({
      text: span,
      rangeStart: this.#rangeStart,
      rangeEnd: this.#rangeStart + this.#renderedSpan.length,
      expected: this.#renderedSpan,
      live,
    });
    if (replaced) {
      this.#transcript = merged;
      this.#renderedSpan = span;
      return;
    }

    // The span moved out from under us. Re-anchor on whatever is there now and
    // treat this transcript as the start of a new one, so the user's edit
    // survives instead of being reverted a second after they made it.
    this.#prefix = this.#options.readPrompt();
    this.#rangeStart = this.#prefix.length;
    this.#transcript = "";
    this.#renderedSpan = "";
    const restarted = joinDictationPrefix(this.#prefix, text).slice(this.#rangeStart);
    if (
      this.#options.writeTranscript({
        text: restarted,
        rangeStart: this.#rangeStart,
        rangeEnd: this.#rangeStart,
        expected: "",
        live,
      })
    ) {
      this.#transcript = text;
      this.#renderedSpan = restarted;
    }
  }

  /**
   * Queue a clip behind whatever is already decoding.
   *
   * Serialising keeps the words in order and keeps several whispers off the CPU
   * at once, which on a live recording is the difference between keeping up and
   * falling further behind with every segment.
   */
  #enqueue(clip: Blob | null, live: boolean): Promise<string | null> {
    if (clip === null || clip.size === 0) {
      // Nothing to send, but queued segments still have to land before the
      // caller may call this dictation finished.
      return this.#queue.then(() => null);
    }
    const prior = this.#options.live ? this.#previousClip : null;
    if (this.#options.live) this.#previousClip = clip;
    this.#setState({ inflight: this.#state.inflight + 1 });

    const overlap = this.#options.overlapAudio ?? withAudioOverlap;
    const encode = this.#options.encodeAudio ?? blobToBase64;
    const next = this.#queue.then(async (): Promise<string | null> => {
      try {
        const audio = prior === null ? clip : await overlap(prior, clip);
        const text = await this.#options.transcribe({
          audioBase64: await encode(audio),
          mimeType: audio.type || "audio/webm",
          live,
        });
        const trimmed = text.trim();
        if (trimmed.length > 0) {
          this.#append(trimmed, live);
          return null;
        }
        // Silence is normal in a live segment, and in the tail after one — you
        // stop talking before you let go. Only a whole clip of it is worth
        // saying out loud.
        return live || this.#delivered > 0 ? null : "Nothing heard.";
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      } finally {
        this.#setState({ inflight: Math.max(0, this.#state.inflight - 1) });
      }
    });
    this.#queue = next;
    return next;
  }

  async begin(): Promise<void> {
    if (this.isRecording) return;
    this.#starting = true;
    this.#delivered = 0;
    this.#previousClip = null;
    this.#queue = Promise.resolve();
    this.#prefix = this.#options.readPrompt();
    this.#rangeStart = this.#prefix.length;
    this.#transcript = "";
    this.#renderedSpan = "";
    this.#setState({ phase: "starting", error: null, elapsedSeconds: 0, inflight: 0 });

    const live = this.#options.live;
    const open = this.#options.openRecorder ?? startRecording;
    let handle: RecordingHandle;
    try {
      handle = await open({
        segmentSeconds: live ? this.#options.liveSegmentSeconds : 0,
        onSegment: live ? (clip) => void this.#enqueue(clip, true) : undefined,
      });
    } catch (cause) {
      this.#starting = false;
      this.#setState({
        phase: "idle",
        error:
          cause instanceof MicrophoneUnavailableError
            ? cause.message
            : `Could not start recording: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
      return;
    }
    this.#starting = false;

    // Let go before the mic opened: nothing worth transcribing.
    if (this.#releasedWhileStarting) {
      this.#releasedWhileStarting = false;
      handle.cancel();
      this.#setState({ phase: "idle" });
      return;
    }

    this.#handle = handle;
    this.#startedAt = Date.now();
    this.#setState({ phase: "recording" });
    this.#ticker = setInterval(() => {
      this.#setState({ elapsedSeconds: Math.floor((Date.now() - this.#startedAt) / 1000) });
    }, 500);
  }

  async finish(): Promise<void> {
    if (this.#starting) {
      this.#releasedWhileStarting = true;
      return;
    }
    const handle = this.#handle;
    if (handle === null) return;
    this.#handle = null;
    if (this.#ticker !== null) clearInterval(this.#ticker);
    this.#ticker = null;
    this.#setState({ phase: "transcribing", latched: false });

    try {
      // The tail after the last live segment; the whole clip when live is off.
      const error = await this.#enqueue(await handle.stop(), false);
      this.#setState({ phase: "idle", error });
    } catch (cause) {
      this.#setState({
        phase: "idle",
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  /** Pointer down, or the push-to-talk key going down. */
  press(): void {
    if (this.isRecording) {
      void this.finish();
      return;
    }
    void this.begin();
  }

  /** Let go: a real hold ends the clip, a quick tap latches recording on. */
  release(heldMs: number): void {
    if (!this.isRecording) return;
    if (heldMs < TAP_MS) {
      this.#setState({ latched: true });
      return;
    }
    void this.finish();
  }

  /** Keyboard push-to-talk never uses the quick-tap latch. */
  keyPress(): boolean {
    if (this.isRecording) {
      void this.finish();
      return false;
    }
    void this.begin();
    return true;
  }

  keyRelease(): void {
    void this.finish();
  }

  /** Take an error off the status line once it has been read. */
  clearError(): void {
    if (this.#state.error !== null) this.#setState({ error: null });
  }

  /** Tear down without waiting for anything: the composer is going away. */
  dispose(): void {
    if (this.#ticker !== null) clearInterval(this.#ticker);
    this.#ticker = null;
    this.#handle?.cancel();
    this.#handle = null;
  }
}
