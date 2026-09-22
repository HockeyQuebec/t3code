import { MicIcon, SquareIcon } from "lucide-react";
import { memo, useEffect, useRef, useState, type PointerEvent } from "react";

import { cn } from "~/lib/utils";
import type { DictationSession, DictationSessionState } from "~/lib/dictationSession";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The mic under the composer.
 *
 * Hold it and speak, then let go. A quick tap latches recording on instead, so
 * a long dictation does not need a held finger. Everything behind the button
 * lives in `DictationSession`; this only decides what a recording looks like.
 */

/** What the button says about itself, given where the session has got to. */
export function dictationLabel(state: DictationSessionState): string {
  if (state.phase === "recording") {
    return state.latched ? "Tap to stop" : "Recording";
  }
  if (state.phase === "transcribing" || state.inflight > 0) {
    return "Transcribing…";
  }
  if (state.phase === "starting") {
    return "Starting…";
  }
  return "Dictate";
}

/** mm:ss, because a dictation long enough to need hours is not a dictation. */
export function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

interface DictationControlProps {
  readonly session: DictationSession;
  readonly state: DictationSessionState;
  /** Disabled while the composer itself cannot accept text. */
  readonly disabled: boolean;
  /** Named in the tooltip so the space-bar shortcut is discoverable. */
  readonly spaceBarPushToTalk: boolean;
}

export const DictationControl = memo(function DictationControl({
  session,
  state,
  disabled,
  spaceBarPushToTalk,
}: DictationControlProps) {
  const pressedAt = useRef(0);
  const recording = state.phase === "recording" || state.phase === "starting";

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    pressedAt.current = Date.now();
    session.press();
  };
  const onPointerUp = () => {
    session.release(Date.now() - pressedAt.current);
  };

  return (
    <div className="flex items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              aria-label={recording ? "Stop dictation" : "Dictate"}
              aria-pressed={recording}
              className={cn(recording && "text-destructive hover:text-destructive")}
              disabled={disabled}
              onPointerCancel={onPointerUp}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              // A pointerup outside the button still ends the hold.
              onLostPointerCapture={onPointerUp}
              type="button"
            />
          }
        >
          <ComposerControlIcon icon={recording ? SquareIcon : MicIcon} />
          {recording ? formatElapsed(state.elapsedSeconds) : null}
        </TooltipTrigger>
        <TooltipPopup>
          Hold to talk, then let go to transcribe. A quick tap latches recording on until you tap
          again.
          {spaceBarPushToTalk
            ? " Holding the space bar outside a text box does the same."
            : ""}{" "}
          Transcribed locally — speed, live dictation and translate-to-English are in Settings ›
          Dictation.
        </TooltipPopup>
      </Tooltip>
      {state.error !== null || state.inflight > 0 || state.latched ? (
        <span
          className={cn(
            "text-xs tabular-nums",
            state.error === null ? "text-muted-foreground/70" : "text-destructive",
          )}
        >
          {state.error ?? dictationLabel(state)}
        </span>
      ) : null}
    </div>
  );
});

/**
 * Track a session's state as React state.
 *
 * The session pushes rather than the component polling, because a recording
 * updates on its own schedule — a timer tick, a segment landing — and none of
 * those are renders.
 */
export function useDictationSessionState(session: DictationSession): DictationSessionState {
  const [state, setState] = useState(session.state);
  useEffect(() => {
    session.configure({ onStateChange: setState });
    setState(session.state);
  }, [session]);

  // An error has been read by the time it has sat there this long, and leaving
  // it under the composer forever reads as a state rather than an event.
  useEffect(() => {
    if (state.error === null) return;
    const timer = setTimeout(() => session.clearError(), ERROR_HOLD_MS);
    return () => clearTimeout(timer);
  }, [session, state.error]);

  return state;
}

/** How long an error stays under the composer before it clears itself. */
const ERROR_HOLD_MS = 5000;
