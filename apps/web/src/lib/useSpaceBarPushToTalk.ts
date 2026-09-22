import { useEffect } from "react";

import { SPACE_HOLD_MS, type DictationSession } from "./dictationSession";
import { isCommandPaletteOpen } from "../commandPaletteBus";

/**
 * The space bar as a push-to-talk key.
 *
 * This is off unless the user asks for it, because a text editor's space bar
 * has a job already. When it is on, a normal press is still a normal space:
 * only a half-second hold starts recording, and releasing always stops it.
 */

interface SpaceHold {
  readonly session: DictationSession;
  readonly element: HTMLElement | null;
  /** Where the caret sat when the hold began, for undoing key-repeat spaces. */
  readonly selectionStart: number | null;
  readonly typing: boolean;
  started: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
}

function isTextEntry(element: Element | null): element is HTMLElement {
  if (element === null) return false;
  return (
    element.tagName === "TEXTAREA" ||
    element.tagName === "INPUT" ||
    (element as HTMLElement).isContentEditable
  );
}

/**
 * The OS key-repeat behind a held space bar keeps typing spaces into the box.
 * Once the hold crosses the threshold and recording actually starts, take back
 * whatever the repeat already inserted — but only if it was purely spaces, so a
 * race with anything else leaves the user's text alone.
 */
export function stripHeldSpaces(
  element: HTMLInputElement | HTMLTextAreaElement,
  selectionStart: number | null,
): boolean {
  if (selectionStart === null) return false;
  const cursor = element.selectionStart;
  if (cursor === null || cursor < selectionStart) return false;
  const inserted = element.value.slice(selectionStart, cursor);
  if (inserted.length === 0 || !/^ +$/.test(inserted)) return false;
  element.value = element.value.slice(0, selectionStart) + element.value.slice(cursor);
  element.selectionStart = element.selectionEnd = selectionStart;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

export function useSpaceBarPushToTalk(input: {
  readonly session: DictationSession;
  readonly enabled: boolean;
}): void {
  const { session, enabled } = input;

  useEffect(() => {
    if (!enabled) return;
    let hold: SpaceHold | null = null;

    const end = () => {
      if (hold === null) return;
      clearTimeout(hold.timer);
      if (hold.started) hold.session.keyRelease();
      hold = null;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.repeat) {
        // Recording already started from an earlier press of this same hold —
        // stop the key-repeat from filling the box with spaces while you talk.
        if (hold?.started && hold.typing) event.preventDefault();
        return;
      }
      if (hold !== null) return;
      if (isCommandPaletteOpen()) return;

      const element = document.activeElement;
      const typing = isTextEntry(element);
      if (!typing) {
        // Space is also "activate" for whatever control has focus; only steal
        // it when nothing in particular does.
        if (element?.closest?.("button, select, a, summary, [role='button']")) return;
        // Space would otherwise scroll the page.
        event.preventDefault();
      }

      const field =
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element
          : null;
      const selectionStart = field?.selectionStart ?? null;
      const current: SpaceHold = {
        session,
        element: typing ? (element as HTMLElement) : null,
        selectionStart,
        typing,
        started: false,
        timer: setTimeout(() => {
          if (hold !== current) return;
          current.started = session.keyPress();
          if (current.started && field !== null) {
            stripHeldSpaces(field, selectionStart);
          }
        }, SPACE_HOLD_MS),
      };
      hold = current;
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      end();
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    // Browsers do not deliver keyup when the window loses focus mid-hold.
    window.addEventListener("blur", end);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", end);
      end();
    };
  }, [enabled, session]);
}
