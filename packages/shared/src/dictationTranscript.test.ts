import { describe, expect, it } from "vite-plus/test";

import { joinDictationPrefix, mergeTranscript, transcriptWords } from "./dictationTranscript.ts";

describe("transcriptWords", () => {
  it("locates words and lowercases them, keeping apostrophes together", () => {
    expect(transcriptWords("It's a Test")).toEqual([
      { word: "it's", start: 0 },
      { word: "a", start: 5 },
      { word: "test", start: 7 },
    ]);
  });

  it("keeps non-latin scripts as words", () => {
    expect(transcriptWords("привет мир").map((entry) => entry.word)).toEqual(["привет", "мир"]);
  });
});

describe("mergeTranscript", () => {
  it("returns the other side when one is empty", () => {
    expect(mergeTranscript("", "hello there")).toBe("hello there");
    expect(mergeTranscript("hello there", "")).toBe("hello there");
    expect(mergeTranscript("  ", "  ")).toBe("");
  });

  it("drops an exactly repeated tail", () => {
    expect(mergeTranscript("run the tests now", "the tests now and report back")).toBe(
      "run the tests now and report back",
    );
  });

  it("repairs a word the segment boundary clipped", () => {
    expect(mergeTranscript("this is a transcrip", "a transcription test")).toBe(
      "this is a transcription test",
    );
  });

  it("prefers the longest compatible seam", () => {
    expect(mergeTranscript("one two three two three", "two three four")).toBe(
      "one two three two three four",
    );
  });

  it("joins with a space when the segments do not overlap at all", () => {
    expect(mergeTranscript("first sentence.", "entirely different words")).toBe(
      "first sentence. entirely different words",
    );
  });

  it("keeps punctuation that sat before the seam", () => {
    expect(mergeTranscript("stop, then check the", "check the output")).toBe(
      "stop, then check the output",
    );
  });

  it("does not treat a one-letter coincidence as a truncation", () => {
    expect(mergeTranscript("deploy a", "b service")).toBe("deploy a b service");
  });

  it("only looks a bounded distance back, so a long transcript stays cheap", () => {
    const long = Array.from({ length: 200 }, (_, index) => `word${index}`).join(" ");
    expect(mergeTranscript(long, "word0 word1")).toBe(`${long} word0 word1`);
  });
});

describe("joinDictationPrefix", () => {
  it("adds a separator only when the existing text needs one", () => {
    expect(joinDictationPrefix("", "hello")).toBe("hello");
    expect(joinDictationPrefix("fix ", "the bug")).toBe("fix the bug");
    expect(joinDictationPrefix("fix", "the bug")).toBe("fix the bug");
    expect(joinDictationPrefix("fix\n", "the bug")).toBe("fix\nthe bug");
  });
});
