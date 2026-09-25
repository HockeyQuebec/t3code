import type { HarnessCatalogInput, SpendSummaryInput, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback } from "react";

import { usePrimaryEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

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

/** What this device has run on each metered account. */
export function useAccountUsage() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  return useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.accountUsage({ environmentId, input: {} }),
  );
}

/** One chat's tokens, cost, and estimated share of each account's meters. */
export function useThreadUsage(threadId: ThreadId | null) {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  return useEnvironmentQuery(
    environmentId === null || threadId === null
      ? null
      : serverEnvironment.threadUsage({ environmentId, input: { threadId } }),
  );
}

/** Makes a claude-swap account the one new Claude sessions run on. */
export function useSwitchClaudeAccount() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const command = useAtomCommand(serverEnvironment.switchClaudeAccount, { reportFailure: false });

  return useCallback(
    async (cswapAccount: number): Promise<boolean> => {
      if (environmentId === null) {
        return false;
      }
      const result = await command({ environmentId, input: { cswapAccount } });
      if (result._tag === "Failure") {
        throw Cause.squash(result.cause);
      }
      return result.value.switched;
    },
    [environmentId, command],
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
