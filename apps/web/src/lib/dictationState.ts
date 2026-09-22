import type { DictationStatus, EnvironmentId, TranscribeAudioInput } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback } from "react";

import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Dictation runs on the environment that would run the agent, not on whichever
 * one happens to be primary: the Whisper CLI, its models, and the settings that
 * choose between them all live on that machine.
 */

/**
 * Whether this environment can transcribe at all.
 *
 * Answering "no" is the important case — it lets the composer leave the mic out
 * entirely rather than offering a button whose only outcome is an error.
 */
export function useDictationStatus(
  environmentId: EnvironmentId | null,
): DictationStatus | null | undefined {
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.dictationStatus({ environmentId, input: {} }),
  );
  return query.data;
}

/** Post one clip to that environment's Whisper CLI and get its text back. */
export function useTranscribeAudio(environmentId: EnvironmentId | null) {
  const command = useAtomCommand(serverEnvironment.transcribeAudio, { reportFailure: false });

  return useCallback(
    async (input: TranscribeAudioInput): Promise<string> => {
      if (environmentId === null) {
        throw new Error("No environment is selected.");
      }
      const result = await command({ environmentId, input });
      if (result._tag === "Failure") {
        throw Cause.squash(result.cause);
      }
      return result.value.text;
    },
    [environmentId, command],
  );
}
