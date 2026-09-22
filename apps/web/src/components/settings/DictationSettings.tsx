import { MicIcon } from "lucide-react";
import {
  DICTATION_LIVE_OVERLAP_SECS,
  DICTATION_LIVE_SECS_RANGE,
  WHISPER_COMPUTE_CHOICES,
  WHISPER_MODEL_CHOICES,
  type WhisperComputeType,
  type WhisperModel,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { usePrimaryEnvironment } from "../../state/environments";
import { useDictationStatus } from "../../lib/dictationState";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * Dictation runs on a Whisper CLI on the environment's own machine — audio
 * never leaves it. These settings trade accuracy for how long you wait, and can
 * turn the spoken word into English on the way in.
 */

const MODEL_DESCRIPTIONS: Record<WhisperModel, string> = {
  tiny: "Fastest, and mishears the most.",
  base: "Fast, noticeably rougher than small.",
  small: "A good middle, and the default.",
  medium: "Slower and sharper.",
  "large-v3": "Sharpest, and slow enough that you will notice.",
};

const COMPUTE_DESCRIPTIONS: Record<WhisperComputeType, string> = {
  int8: "Fastest. What makes fast mode fast.",
  int8_float32: "A little more accurate than int8.",
  float16: "Half precision; wants a GPU to be worth it.",
  float32: "Full precision, slowest.",
};

/** The line under the heading: what a press of the mic will actually do now. */
function describeDictation(input: {
  readonly live: boolean;
  readonly liveSegmentSeconds: number;
  readonly translate: boolean;
  readonly fast: boolean;
  readonly model: WhisperModel;
  readonly liveModel: WhisperModel | "";
}): string {
  const parts = [
    input.live
      ? `live, ${input.liveSegmentSeconds}s segments + ${DICTATION_LIVE_OVERLAP_SECS}s overlap`
      : "transcribed when you let go",
  ];
  if (input.translate) parts.push("translated to English");
  if (input.fast) parts.push("fast");
  parts.push(
    input.live && input.liveModel.length > 0
      ? `${input.liveModel} live / ${input.model}`
      : input.model,
  );
  return parts.join(" · ");
}

export function DictationSettings() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const primaryEnvironment = usePrimaryEnvironment();
  const status = useDictationStatus(primaryEnvironment?.environmentId ?? null);

  const dictation = settings.dictation;
  const defaults = DEFAULT_UNIFIED_SETTINGS.dictation;
  const update = (patch: Partial<typeof dictation>) => updateSettings({ dictation: patch });

  const unavailable = status !== undefined && status !== null && !status.available;

  return (
    <SettingsSection
      id="settings-dictation"
      title="Dictation"
      icon={<MicIcon className="size-4" />}
    >
      <p className="text-sm text-muted-foreground">
        {dictation.enabled
          ? describeDictation(dictation)
          : "Dictation is off; the composer shows no microphone."}
      </p>
      {unavailable && dictation.enabled ? (
        <p className="text-sm text-destructive">
          No Whisper CLI found on this machine — <code>{status.binary}</code> is not on the PATH.
          Install one with <code>pip install whisper-ctranslate2</code>, or name a different binary
          below.
        </p>
      ) : null}

      <SettingsRow
        id="settings-dictation-enabled"
        title="Dictation"
        description="Show a microphone in the composer and transcribe what you say with a Whisper CLI on this machine. Audio never leaves it."
        control={
          <Switch
            checked={dictation.enabled}
            onCheckedChange={(checked) => update({ enabled: checked })}
          />
        }
      />

      <SettingsRow
        id="settings-dictation-binary"
        title="Whisper binary"
        description="Any CLI taking --model, --output_dir and --output_format works. A bare name is looked up on the PATH; a path is used as given."
        resetAction={
          dictation.binary !== defaults.binary ? (
            <SettingResetButton
              label="whisper binary"
              onClick={() => update({ binary: defaults.binary })}
            />
          ) : null
        }
        control={
          <Input
            className="w-64"
            defaultValue={dictation.binary}
            onBlur={(event) => {
              const next = event.currentTarget.value.trim();
              if (next.length > 0 && next !== dictation.binary) update({ binary: next });
            }}
            placeholder="whisper-ctranslate2"
            spellCheck={false}
          />
        }
      />

      <SettingsRow
        id="settings-dictation-model"
        title="Model"
        description={`${MODEL_DESCRIPTIONS[dictation.model]} This is the main speed dial — a size you have not used before is downloaded on first use.`}
        control={
          <Select
            value={dictation.model}
            onValueChange={(value) => update({ model: value as WhisperModel })}
          >
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {WHISPER_MODEL_CHOICES.map((model) => (
                <SelectItem key={model} value={model}>
                  {model}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        id="settings-dictation-fast"
        title="Fast mode"
        description="Greedy decoding instead of a beam, int8 weights, and silence skipped by the voice detector. Worth about 15% on small and 25% on medium, at a small cost in accuracy."
        control={
          <Switch
            checked={dictation.fast}
            onCheckedChange={(checked) => update({ fast: checked })}
          />
        }
      />

      <SettingsRow
        id="settings-dictation-compute"
        title="Precision"
        description={`${COMPUTE_DESCRIPTIONS[dictation.computeType]} Only faster-whisper reads this; OpenAI's whisper ignores it.`}
        control={
          <Select
            value={dictation.computeType}
            onValueChange={(value) => update({ computeType: value as WhisperComputeType })}
          >
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {WHISPER_COMPUTE_CHOICES.map((choice) => (
                <SelectItem key={choice} value={choice}>
                  {choice}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        id="settings-dictation-language"
        title="Language"
        description="Naming the language you speak is faster and more accurate than making the model detect it. Leave empty to auto-detect, which is what you want before speaking something else."
        control={
          <Input
            className="w-32"
            defaultValue={dictation.language}
            onBlur={(event) => {
              const next = event.currentTarget.value.trim();
              if (next !== dictation.language) update({ language: next });
            }}
            placeholder="auto"
            spellCheck={false}
          />
        }
      />

      <SettingsRow
        id="settings-dictation-translate"
        title="Translate to English"
        description="Speak any language, get English. This is Whisper's translate task — it only ever translates into English, it is not a language pair. With live dictation on, that is real-time translation."
        control={
          <Switch
            checked={dictation.translate}
            onCheckedChange={(checked) => update({ translate: checked })}
          />
        }
      />

      <SettingsRow
        id="settings-dictation-live"
        title="Live dictation"
        description={`Put words in the composer as you speak rather than all at once when you let go. Consecutive segments share ${DICTATION_LIVE_OVERLAP_SECS}s of audio so a word crossing a boundary is recovered.`}
        control={
          <Switch
            checked={dictation.live}
            onCheckedChange={(checked) => update({ live: checked })}
          />
        }
      />

      {dictation.live ? (
        <>
          <SettingsRow
            id="settings-dictation-live-seconds"
            title="Segment length"
            description="Seconds of new speech per live segment. Shorter feels more immediate and asks more of the machine; longer is steadier and lags further behind."
            control={
              <Input
                className="w-24"
                defaultValue={String(dictation.liveSegmentSeconds)}
                max={DICTATION_LIVE_SECS_RANGE.maximum}
                min={DICTATION_LIVE_SECS_RANGE.minimum}
                onBlur={(event) => {
                  const parsed = Number(event.currentTarget.value);
                  if (!Number.isFinite(parsed)) return;
                  const clamped = Math.min(
                    DICTATION_LIVE_SECS_RANGE.maximum,
                    Math.max(DICTATION_LIVE_SECS_RANGE.minimum, Math.round(parsed)),
                  );
                  event.currentTarget.value = String(clamped);
                  if (clamped !== dictation.liveSegmentSeconds) {
                    update({ liveSegmentSeconds: clamped });
                  }
                }}
                step={1}
                type="number"
              />
            }
          />

          <SettingsRow
            id="settings-dictation-live-model"
            title="Live model"
            description="A smaller model for live segments only, so the running transcript keeps up while the final tail still gets the model above."
            control={
              <Select
                value={dictation.liveModel === "" ? "same" : dictation.liveModel}
                onValueChange={(value) =>
                  update({ liveModel: value === "same" ? "" : (value as WhisperModel) })
                }
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="same">Same as above</SelectItem>
                  {WHISPER_MODEL_CHOICES.map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        </>
      ) : null}

      <SettingsRow
        id="settings-dictation-space-bar"
        title="Space bar push-to-talk"
        description="Hold the space bar to talk. A normal press is still a normal space; only a half-second hold starts recording, and releasing always stops it."
        control={
          <Switch
            checked={dictation.spaceBarPushToTalk}
            onCheckedChange={(checked) => update({ spaceBarPushToTalk: checked })}
          />
        }
      />
    </SettingsSection>
  );
}
