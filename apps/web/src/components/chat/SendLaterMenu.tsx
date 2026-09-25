import { ClockIcon } from "lucide-react";
import { useState } from "react";
import type { ProviderLimitSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  resolvePresetMillis,
  SEND_LATER_PRESETS,
  type SendLaterPresetId,
} from "~/lib/scheduledTurnsState";
import { useAgentLimits } from "~/lib/agentLimitsState";
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

/** Past the reset so the first request lands in the fresh window. */
const RESET_SLACK_MS = 15_000;

export interface LimitResetOption {
  readonly key: string;
  readonly label: string;
  readonly runAtMillis: number;
}

/** Emails are long and the menu is not. */
function accountLabel(label: string): string {
  const at = label.indexOf("@");
  return at > 0 ? label.slice(0, at) : label;
}

/**
 * One "when it resets" choice per account with a known upcoming reset. The
 * binding window is the one actually blocking work, so its reset is the one
 * worth waiting for; the 5h window stands in when nothing binds yet.
 */
export function buildLimitResetOptions(
  providers: ReadonlyArray<ProviderLimitSnapshot>,
  nowMillis: number,
): ReadonlyArray<LimitResetOption> {
  return providers.flatMap((provider) => {
    const window = Option.getOrNull(Option.orElse(provider.binding, () => provider.short));
    const resetsAt = window === null ? null : Option.getOrNull(window.resetsAt);
    if (resetsAt === null) return [];
    const millis = DateTime.toEpochMillis(resetsAt);
    if (millis <= nowMillis) return [];
    return [
      {
        key: provider.instanceId,
        label: `When ${accountLabel(provider.label)} resets`,
        runAtMillis: millis + RESET_SLACK_MS,
      },
    ];
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
  const { data: limits } = useAgentLimits();

  // Never offer a control that cannot do anything.
  if (onSchedule === null) {
    return null;
  }

  const nowMillis = Date.now();
  const options = buildSendLaterOptions(nowMillis);
  const resetOptions = buildLimitResetOptions(limits?.providers ?? [], nowMillis);

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
        {resetOptions.map((option) => (
          <MenuItem
            key={option.key}
            disabled={disabled}
            onClick={() => void onSchedule(new Date(option.runAtMillis).toISOString())}
          >
            <span>{option.label}</span>
            <span className="text-muted-foreground">· {formatShortTime(option.runAtMillis)}</span>
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
