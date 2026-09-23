import type { MenuBarSection, MenuBarTitle } from "@t3tools/contracts/settings";

import { Checkbox } from "../ui/checkbox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const MENU_BAR_TITLE_LABELS = {
  icon: "Icon only",
  counts: "Agent counts",
  limits: "Usage limit",
  "counts-and-limits": "Counts and usage",
} satisfies Record<MenuBarTitle, string>;

const MENU_BAR_SECTION_LABELS = {
  working: "Working threads",
  finished: "Recently finished",
  limits: "Usage limits",
} satisfies Record<MenuBarSection, string>;

function isMenuBarTitle(value: unknown): value is MenuBarTitle {
  return typeof value === "string" && value in MENU_BAR_TITLE_LABELS;
}

/** The macOS menu bar item: whether it shows, its text, and its dropdown groups. */
export function MenuBarSettings() {
  const enabled = useScopedSettings((settings) => settings.menuBarEnabled);
  const title = useScopedSettings((settings) => settings.menuBarTitle);
  const sections = useScopedSettings((settings) => settings.menuBarSections);
  const updateSettings = useUpdateScopedSettings();
  if (window.desktopBridge?.getClientPlatform?.() !== "darwin") return null;

  const toggleSection = (section: MenuBarSection, checked: boolean) =>
    updateSettings({
      menuBarSections: (Object.keys(MENU_BAR_SECTION_LABELS) as MenuBarSection[]).filter(
        (candidate) => (candidate === section ? checked : sections.includes(candidate)),
      ),
    });

  return (
    <>
      <SettingsRow
        {...searchableSetting("menu-bar")}
        description="Show agent status in the macOS menu bar. Threads that need you are always listed; click one to open it."
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => updateSettings({ menuBarEnabled: checked })}
            aria-label="Show in menu bar"
          />
        }
      >
        {enabled ? (
          <div className="flex flex-wrap gap-x-4 gap-y-2 pt-2 pb-2">
            {(Object.entries(MENU_BAR_SECTION_LABELS) as [MenuBarSection, string][]).map(
              ([section, label]) => (
                <label key={section} className="flex cursor-pointer items-center gap-2 text-xs">
                  <Checkbox
                    checked={sections.includes(section)}
                    onCheckedChange={(checked) => toggleSection(section, checked === true)}
                  />
                  {label}
                </label>
              ),
            )}
          </div>
        ) : null}
      </SettingsRow>
      {enabled ? (
        <SettingsRow
          title={searchableSetting("menu-bar-text").title}
          description="Counts show threads needing you (!) and running (↻). Usage shows the fullest limit window."
          control={
            <Select
              value={title}
              onValueChange={(value) => {
                if (isMenuBarTitle(value)) updateSettings({ menuBarTitle: value });
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Menu bar text">
                <SelectValue>{MENU_BAR_TITLE_LABELS[title]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {Object.entries(MENU_BAR_TITLE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} hideIndicator value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </>
  );
}
