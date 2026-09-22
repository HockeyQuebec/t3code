import { createFileRoute } from "@tanstack/react-router";

import { AgentUsageSettings } from "../components/settings/AgentUsageSettings";
import { ScheduledWorkSettings } from "../components/settings/ScheduledWorkSettings";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function UsageSettingsPanel() {
  return (
    <SettingsPageContainer className="max-w-6xl gap-10">
      <ScheduledWorkSettings />
      <AgentUsageSettings />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/usage")({
  component: UsageSettingsPanel,
});
