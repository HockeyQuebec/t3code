import { createFileRoute } from "@tanstack/react-router";

import { DictationSettings } from "../components/settings/DictationSettings";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function DictationSettingsPanel() {
  return (
    <SettingsPageContainer>
      <DictationSettings />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/dictation")({
  component: DictationSettingsPanel,
});
