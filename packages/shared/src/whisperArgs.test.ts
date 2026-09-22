import type { DictationSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { decodeArgs, isFasterWhisper, modelForClip, taskArgs, whisperArgs } from "./whisperArgs.ts";

const SETTINGS: DictationSettings = {
  enabled: true,
  binary: "whisper-ctranslate2",
  model: "small",
  language: "en",
  fast: true,
  computeType: "int8",
  translate: false,
  live: true,
  liveSegmentSeconds: 6,
  liveModel: "",
  spaceBarPushToTalk: false,
};

const settings = (overrides: Partial<DictationSettings> = {}): DictationSettings => ({
  ...SETTINGS,
  ...overrides,
});

const FASTER = "/usr/local/bin/whisper-ctranslate2";
const OPENAI = "/usr/local/bin/whisper";

describe("isFasterWhisper", () => {
  it("recognises the ctranslate2 front-end by executable name only", () => {
    expect(isFasterWhisper(FASTER)).toBe(true);
    expect(isFasterWhisper("whisper-ctranslate2")).toBe(true);
    expect(isFasterWhisper(OPENAI)).toBe(false);
    // A directory that happens to be named for it is not the front-end.
    expect(isFasterWhisper("/opt/ctranslate2/bin/whisper")).toBe(false);
  });
});

describe("decodeArgs", () => {
  it("is empty for a finished clip when fast mode is off", () => {
    expect(
      decodeArgs({
        binaryPath: FASTER,
        settings: settings({ fast: false }),
        live: false,
        cpuCount: 8,
      }),
    ).toEqual([]);
  });

  it("takes the fast path for a live segment even when fast mode is off", () => {
    const args = decodeArgs({
      binaryPath: FASTER,
      settings: settings({ fast: false }),
      live: true,
      cpuCount: 8,
    });
    expect(args).toContain("--beam_size");
    expect(args).toContain("--vad_filter");
  });

  it("omits the quantisation and VAD flags for OpenAI's whisper", () => {
    const args = decodeArgs({ binaryPath: OPENAI, settings: settings(), live: false, cpuCount: 8 });
    expect(args).toContain("--beam_size");
    expect(args).not.toContain("--compute_type");
    expect(args).not.toContain("--vad_filter");
  });

  it("passes the configured quantisation to faster-whisper", () => {
    const args = decodeArgs({
      binaryPath: FASTER,
      settings: settings({ computeType: "float16" }),
      live: false,
      cpuCount: 8,
    });
    expect(args.slice(args.indexOf("--compute_type"), args.indexOf("--compute_type") + 2)).toEqual([
      "--compute_type",
      "float16",
    ]);
  });

  it("caps threads so a busy machine is not oversubscribed, and never asks for zero", () => {
    const threadsFor = (cpuCount: number) => {
      const args = decodeArgs({ binaryPath: FASTER, settings: settings(), live: false, cpuCount });
      return args[args.indexOf("--threads") + 1];
    };
    expect(threadsFor(4)).toBe("4");
    expect(threadsFor(32)).toBe("8");
    expect(threadsFor(0)).toBe("4");
  });
});

describe("taskArgs", () => {
  it("transcribes in the named language by default", () => {
    expect(taskArgs(settings({ language: "fr" }))).toEqual([
      "--task",
      "transcribe",
      "--language",
      "fr",
    ]);
  });

  it("auto-detects when no language is set", () => {
    expect(taskArgs(settings({ language: "" }))).toEqual(["--task", "transcribe"]);
  });

  it("drops an English source language when translating, since the target is English", () => {
    expect(taskArgs(settings({ translate: true, language: "en" }))).toEqual([
      "--task",
      "translate",
    ]);
    expect(taskArgs(settings({ translate: true, language: "English" }))).toEqual([
      "--task",
      "translate",
    ]);
  });

  it("keeps a non-English source language when translating", () => {
    expect(taskArgs(settings({ translate: true, language: "ja" }))).toEqual([
      "--task",
      "translate",
      "--language",
      "ja",
    ]);
  });
});

describe("modelForClip", () => {
  it("uses the live model only for live segments, and only when one is set", () => {
    expect(modelForClip(settings({ liveModel: "tiny" }), true)).toBe("tiny");
    expect(modelForClip(settings({ liveModel: "tiny" }), false)).toBe("small");
    expect(modelForClip(settings({ liveModel: "" }), true)).toBe("small");
  });
});

describe("whisperArgs", () => {
  it("puts the clip first and asks for a txt transcript beside it", () => {
    const args = whisperArgs({
      binaryPath: FASTER,
      audioPath: "/tmp/clip.wav",
      outputDir: "/tmp",
      settings: settings({ fast: false }),
      live: false,
      cpuCount: 8,
    });
    expect(args).toEqual([
      "/tmp/clip.wav",
      "--model",
      "small",
      "--output_dir",
      "/tmp",
      "--output_format",
      "txt",
      "--task",
      "transcribe",
      "--language",
      "en",
    ]);
  });
});
