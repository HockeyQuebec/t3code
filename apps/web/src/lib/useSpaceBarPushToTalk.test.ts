// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";

import { stripHeldSpaces } from "./useSpaceBarPushToTalk";

function field(value: string, cursor: number): HTMLTextAreaElement {
  const element = document.createElement("textarea");
  element.value = value;
  element.selectionStart = element.selectionEnd = cursor;
  return element;
}

describe("stripHeldSpaces", () => {
  it("removes the spaces key-repeat typed while the hold was building", () => {
    // "fix" + three spaces from the repeat, caret at the end.
    const element = field("fix   ", 6);
    expect(stripHeldSpaces(element, 3)).toBe(true);
    expect(element.value).toBe("fix");
    expect(element.selectionStart).toBe(3);
  });

  it("leaves the box alone when something other than spaces arrived", () => {
    const element = field("fix the", 7);
    expect(stripHeldSpaces(element, 3)).toBe(false);
    expect(element.value).toBe("fix the");
  });

  it("does nothing when the caret moved backwards, or nothing was inserted", () => {
    const moved = field("fix   ", 1);
    expect(stripHeldSpaces(moved, 3)).toBe(false);
    expect(moved.value).toBe("fix   ");

    const unchanged = field("fix", 3);
    expect(stripHeldSpaces(unchanged, 3)).toBe(false);
    expect(unchanged.value).toBe("fix");
  });

  it("does nothing without a recorded caret position", () => {
    const element = field("fix   ", 6);
    expect(stripHeldSpaces(element, null)).toBe(false);
    expect(element.value).toBe("fix   ");
  });
});
