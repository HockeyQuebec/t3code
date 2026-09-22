import { ClockIcon } from "lucide-react";
import { useState } from "react";

import {
  resolvePresetMillis,
  SEND_LATER_PRESETS,
  type SendLaterPresetId,
} from "~/lib/scheduledTurnsState";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

interface SendLaterMenuProps {
  disabled: boolean;
  /** null when there is nothing to schedule (no thread yet, or empty prompt). */
  onSchedule: ((runAtIso: string) => void | Promise<void>) | null;
}

export interface SendLaterOption {
  readonly id: SendLaterPresetId;
  readonly label: string;
  readonly runAtIso: string;
  /** The resolved wall-clock time, so the reader is never guessing. */
  readonly timeLabel: string;
}

/** Short local time, e.g. "5:12 PM". */
function formatShortTime(millis: number): string {
  return new Date(millis).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The preset choices resolved against a clock.
 *
 * Kept pure so the labels and the ISO instants a click sends can be checked
 * without driving the popup.
 */
export function buildSendLaterOptions(nowMillis: number): ReadonlyArray<SendLaterOption> {
  return SEND_LATER_PRESETS.map((preset) => {
    const millis = resolvePresetMillis(preset.id, nowMillis);
    return {
      id: preset.id,
      label: preset.label,
      runAtIso: new Date(millis).toISOString(),
      timeLabel: formatShortTime(millis),
    };
  });
}

/** What a menu click does, so the behaviour is testable without a DOM. */
export function schedulePreset(
  onSchedule: (runAtIso: string) => void | Promise<void>,
  preset: SendLaterPresetId,
  nowMillis: number,
): void {
  void onSchedule(new Date(resolvePresetMillis(preset, nowMillis)).toISOString());
}

export function SendLaterMenu({ disabled, onSchedule }: SendLaterMenuProps) {
  const [customValue, setCustomValue] = useState("");
  const [showCustom, setShowCustom] = useState(false);

  // Never offer a control that cannot do anything.
  if (onSchedule === null) {
    return null;
  }

  const options = buildSendLaterOptions(Date.now());

  const submitCustom = () => {
    if (customValue === "") {
      return;
    }
    const millis = new Date(customValue).getTime();
    if (Number.isNaN(millis)) {
      return;
    }
    void onSchedule(new Date(millis).toISOString());
    setCustomValue("");
    setShowCustom(false);
  };

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            className="rounded-full text-muted-foreground"
            disabled={disabled}
            aria-label="Send later"
          />
        }
      >
        <ClockIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" side="top">
        {options.map((option) => (
          <MenuItem
            key={option.id}
            disabled={disabled}
            onClick={() => schedulePreset(onSchedule, option.id, Date.now())}
          >
            <span>{option.label}</span>
            <span className="text-muted-foreground">· {option.timeLabel}</span>
          </MenuItem>
        ))}
        {showCustom ? (
          <div className="flex items-center gap-1.5 px-2 py-1.5">
            <input
              type="datetime-local"
              aria-label="Pick a time"
              className="rounded-sm border border-border/60 bg-background px-1.5 py-1 text-xs text-foreground"
              value={customValue}
              onChange={(event) => setCustomValue(event.target.value)}
            />
            <Button size="sm" variant="outline" disabled={disabled} onClick={submitCustom}>
              Queue
            </Button>
          </div>
        ) : (
          <MenuItem disabled={disabled} closeOnClick={false} onClick={() => setShowCustom(true)}>
            Pick a time…
          </MenuItem>
        )}
      </MenuPopup>
    </Menu>
  );
}
