import type { HarnessCatalogInput, SpendSummaryInput } from "@t3tools/contracts";

import { usePrimaryEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";

/**
 * How much headroom each provider subscription has left.
 *
 * The stream only carries a message when a provider announces new numbers, so
 * holding this open costs nothing while nothing is running.
 */
export function useAgentLimits() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  return useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.agentLimits({ environmentId, input: {} }),
  );
}

export function useSpendSummary(input: SpendSummaryInput) {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  return useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.spendSummary({ environmentId, input }),
  );
}

/**
 * The Agent Harness workflows the project at `cwd` declares. Pass `null` to
 * hold off until a project is chosen rather than asking about the wrong tree.
 */
export function useHarnessCatalog(input: HarnessCatalogInput | null) {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  return useEnvironmentQuery(
    environmentId === null || input === null
      ? null
      : serverEnvironment.harnessCatalog({ environmentId, input }),
  );
}
