import { describe, expect, it } from "vite-plus/test";

import type { RecordingHandle, StartRecordingOptions } from "./dictationAudio";
import { DictationSession, type DictationSessionState } from "./dictationSession";

/**
 * A composer standing in for the real one: it holds a string and applies the
 * same guarded range replacement `applyPromptReplacement` does, so the rule
 * that matters most here — an edit made while whisper was catching up is never
 * overwritten — is exercised honestly rather than asserted about.
 */
function fakeComposer(initial = "") {
  let value = initial;
  return {
    read: () => value,
    write: (input: {
      text: string;
      rangeStart: number;
      rangeEnd: number;
      expected: string;
    }): boolean => {
      if (value.slice(input.rangeStart, input.rangeEnd) !== input.expected) {
        return false;
      }
      value = value.slice(0, input.rangeStart) + input.text + value.slice(input.rangeEnd);
      return true;
    },
    edit: (next: string) => {
      value = next;
    },
    get value() {
      return value;
    },
  };
}

/** A microphone whose segments and tail the test decides, on its own schedule. */
function fakeRecorder() {
  let onSegment: ((clip: Blob) => void) | undefined;
  let tail: Blob | null = null;
  let cancelled = false;
  let opened = false;

  const open = async (options: StartRecordingOptions = {}): Promise<RecordingHandle> => {
    opened = true;
    onSegment = options.onSegment;
    return {
      stop: async () => tail,
      cancel: () => {
        cancelled = true;
      },
    };
  };

  return {
    open,
    get opened() {
      return opened;
    },
    get cancelled() {
      return cancelled;
    },
    emitSegment: (label: string) => onSegment?.(new Blob([label], { type: "audio/webm" })),
    setTail: (label: string | null) => {
      tail = label === null ? null : new Blob([label], { type: "audio/webm" });
    },
  };
}

interface Harness {
  readonly composer: ReturnType<typeof fakeComposer>;
  readonly recorder: ReturnType<typeof fakeRecorder>;
  readonly session: DictationSession;
  readonly states: DictationSessionState[];
  /** The clip labels handed to transcription, in the order they were sent. */
  readonly sent: string[];
}

function makeHarness(options: {
  initial?: string;
  live?: boolean;
  transcribe: (label: string, live: boolean) => Promise<string>;
}): Harness {
  const composer = fakeComposer(options.initial ?? "");
  const recorder = fakeRecorder();
  const states: DictationSessionState[] = [];
  const sent: string[] = [];

  const session = new DictationSession({
    // Clips carry their label as their bytes, so a test can say which arrived.
    transcribe: async (input) => {
      sent.push(input.audioBase64);
      return options.transcribe(input.audioBase64, input.live);
    },
    readPrompt: composer.read,
    writeTranscript: composer.write,
    onStateChange: (state) => states.push(state),
    live: options.live ?? false,
    liveSegmentSeconds: 6,
    openRecorder: recorder.open,
    overlapAudio: async (_previous, current) => current,
    encodeAudio: async (blob) => blob.text(),
  });

  return { composer, recorder, session, states, sent };
}

describe("DictationSession", () => {
  it("starts idle with nothing in flight", () => {
    const { session } = makeHarness({ transcribe: async () => "" });
    expect(session.state.phase).toBe("idle");
    expect(session.isRecording).toBe(false);
    expect(session.state.inflight).toBe(0);
  });

  it("puts a finished clip's text in an empty composer", async () => {
    const harness = makeHarness({ transcribe: async () => "run the tests" });
    await harness.session.begin();
    harness.recorder.setTail("clip");
    await harness.session.finish();

    expect(harness.composer.value).toBe("run the tests");
    expect(harness.session.state.phase).toBe("idle");
    expect(harness.session.state.error).toBeNull();
  });

  it("appends after existing text with a separating space", async () => {
    const harness = makeHarness({ initial: "fix", transcribe: async () => "the bug" });
    await harness.session.begin();
    harness.recorder.setTail("clip");
    await harness.session.finish();

    expect(harness.composer.value).toBe("fix the bug");
  });

  it("does not add a second space when the text already ends in one", async () => {
    const harness = makeHarness({ initial: "fix ", transcribe: async () => "the bug" });
    await harness.session.begin();
    harness.recorder.setTail("clip");
    await harness.session.finish();

    expect(harness.composer.value).toBe("fix the bug");
  });

  it("reconciles live segments that repeat a second of audio", async () => {
    const transcripts: Record<string, string> = {
      one: "this is a transcrip",
      two: "a transcription test",
      tail: "test and nothing more",
    };
    const harness = makeHarness({
      live: true,
      transcribe: async (label) => transcripts[label] ?? "",
    });

    await harness.session.begin();
    harness.recorder.emitSegment("one");
    harness.recorder.emitSegment("two");
    harness.recorder.setTail("tail");
    await harness.session.finish();

    expect(harness.composer.value).toBe("this is a transcription test and nothing more");
  });

  it("transcribes clips strictly in order even when an early one is slow", async () => {
    const order: string[] = [];
    const harness = makeHarness({
      live: true,
      transcribe: async (label) => {
        // The first segment resolves last if the queue is not serialised.
        if (label === "one") await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(label);
        return label;
      },
    });

    await harness.session.begin();
    harness.recorder.emitSegment("one");
    harness.recorder.emitSegment("two");
    harness.recorder.setTail("three");
    await harness.session.finish();

    expect(order).toEqual(["one", "two", "three"]);
    expect(harness.composer.value).toBe("one two three");
  });

  it("keeps an edit made while whisper was catching up, and starts a fresh span", async () => {
    const harness = makeHarness({
      live: true,
      transcribe: async (label) => label,
    });

    await harness.session.begin();
    harness.recorder.emitSegment("first");
    // Let the first segment land before the user rewrites the box.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.composer.value).toBe("first");

    harness.composer.edit("I typed this instead");
    harness.recorder.setTail("second");
    await harness.session.finish();

    expect(harness.composer.value).toBe("I typed this instead second");
  });

  it("says nothing was heard only when the whole recording was silent", async () => {
    const silent = makeHarness({ transcribe: async () => "" });
    await silent.session.begin();
    silent.recorder.setTail("clip");
    await silent.session.finish();
    expect(silent.session.state.error).toBe("Nothing heard.");

    // A silent tail after a segment that did produce words is just the pause
    // before you let go, and must not be reported as a failure.
    const spoke = makeHarness({
      live: true,
      transcribe: async (label) => (label === "one" ? "hello" : ""),
    });
    await spoke.session.begin();
    spoke.recorder.emitSegment("one");
    spoke.recorder.setTail("quiet");
    await spoke.session.finish();
    expect(spoke.session.state.error).toBeNull();
    expect(spoke.composer.value).toBe("hello");
  });

  it("surfaces a transcription failure without losing what already landed", async () => {
    const harness = makeHarness({
      live: true,
      transcribe: async (label) => {
        if (label === "bad") throw new Error("whisper exited 1");
        return label;
      },
    });

    await harness.session.begin();
    harness.recorder.emitSegment("good");
    harness.recorder.setTail("bad");
    await harness.session.finish();

    expect(harness.composer.value).toBe("good");
    expect(harness.session.state.error).toBe("whisper exited 1");
  });

  it("reports a microphone that will not open, and stays idle", async () => {
    const composer = fakeComposer();
    const session = new DictationSession({
      transcribe: async () => "",
      readPrompt: composer.read,
      writeTranscript: composer.write,
      onStateChange: () => {},
      live: false,
      liveSegmentSeconds: 6,
      openRecorder: async () => {
        throw new Error("Permission denied");
      },
    });

    await session.begin();
    expect(session.state.phase).toBe("idle");
    expect(session.state.error).toContain("Permission denied");
    expect(session.isRecording).toBe(false);
  });

  it("throws the clip away when the button is released before the mic opened", async () => {
    const harness = makeHarness({ transcribe: async () => "should never run" });
    // `release` lands while `begin` is still awaiting the recorder.
    const starting = harness.session.begin();
    harness.session.release(900);
    await starting;

    expect(harness.recorder.cancelled).toBe(true);
    expect(harness.composer.value).toBe("");
    expect(harness.session.state.phase).toBe("idle");
  });

  it("a quick tap latches recording on; a hold ends it", async () => {
    const harness = makeHarness({ transcribe: async () => "text" });
    await harness.session.begin();

    harness.session.release(100);
    expect(harness.session.state.latched).toBe(true);
    expect(harness.session.isRecording).toBe(true);

    harness.recorder.setTail("clip");
    await harness.session.finish();
    expect(harness.session.state.latched).toBe(false);
    expect(harness.session.isRecording).toBe(false);
  });

  it("keyboard push-to-talk never latches", async () => {
    const harness = makeHarness({ transcribe: async () => "text" });
    expect(harness.session.keyPress()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.session.isRecording).toBe(true);
    expect(harness.session.state.latched).toBe(false);

    // Pressing again while recording stops rather than starting a second one.
    expect(harness.session.keyPress()).toBe(false);
  });

  it("ignores a second press while already recording", async () => {
    const harness = makeHarness({ transcribe: async () => "text" });
    await harness.session.begin();
    const openedOnce = harness.recorder.opened;
    await harness.session.begin();
    expect(openedOnce).toBe(true);
    expect(harness.session.isRecording).toBe(true);
  });
});
