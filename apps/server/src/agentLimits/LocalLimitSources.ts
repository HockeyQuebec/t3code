import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderLimitSnapshot,
} from "@t3tools/contracts";
import {
  type AgentLimitState,
  bindingWindow,
  EMPTY_LIMIT_STATE,
  limitLevel,
  parseCodexSessionLimits,
  parseCswapList,
  parseCursorAboutTier,
} from "@t3tools/shared/agentLimits";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";

import { ProcessRunner } from "../processRunner.ts";
import { AgentLimits, toWindow } from "./AgentLimits.ts";

/**
 * Limits for accounts T3 Code is not currently running a turn on.
 *
 * The event stream only knows about the account a provider is using right now,
 * so the sidebar would stay blank until the first turn and never show the
 * other Claude accounts claude-swap rotates between. These pollers read what
 * the local tools already keep on disk or print cheaply, and hand the rows to
 * {@link AgentLimits}. A tool that is not installed yields no rows.
 */

/** claude-swap caches its usage fetches, so this mostly reads its cache. */
const CSWAP_INTERVAL = "2 minutes";
const CODEX_INTERVAL = "1 minute";
/** Only the plan tier is available for Cursor, and that rarely changes. */
const CURSOR_INTERVAL = "30 minutes";
/** Enough of a session log's tail to hold its last `token_count` event. */
const CODEX_TAIL_BYTES = 256 * 1024;

function row(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly label: string;
  readonly detail?: string | undefined;
  readonly cswapAccount?: number;
  readonly active?: boolean;
  readonly state: AgentLimitState;
}): ProviderLimitSnapshot {
  const { state } = input;
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    label: input.label,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.cswapAccount === undefined ? {} : { cswapAccount: input.cswapAccount }),
    ...(input.active ? { active: true } : {}),
    short: toWindow(state.short),
    long: toWindow(state.long),
    binding: toWindow(bindingWindow(state)),
    level: limitLevel(state),
    source: state.source,
    observedAt:
      state.observedAt === null
        ? Option.none()
        : Option.some(DateTime.makeUnsafe(state.observedAt * 1000)),
  };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export class LocalLimitSources extends Context.Service<
  LocalLimitSources,
  {
    /**
     * Points claude-swap at another account (`cswap switch <n>`), then re-reads
     * the list so every client sees the new active row without waiting a poll.
     */
    readonly switchClaudeAccount: (
      cswapAccount: number,
    ) => Effect.Effect<{ readonly switched: boolean }>;
  }
>()("t3/agentLimits/LocalLimitSources") {}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const agentLimits = yield* AgentLimits;
  const processRunner = yield* ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const newestEntry = Effect.fn("localLimits.newestEntry")(function* (
    directory: string,
    filter: (name: string) => boolean,
  ) {
    const names = (yield* fs.readDirectory(directory)).filter(filter).toSorted();
    const last = names.at(-1);
    return last === undefined ? null : path.join(directory, last);
  });

  /** Session logs live under `sessions/YYYY/MM/DD/*.jsonl`, so the newest day sorts last. */
  const readNewestCodexSessionTail = Effect.gen(function* () {
    const codexHome = process.env.CODEX_HOME ?? path.join(NodeOS.homedir(), ".codex");
    let directory: string | null = path.join(codexHome, "sessions");
    for (let depth = 0; depth < 3 && directory !== null; depth += 1) {
      directory = yield* newestEntry(directory, (name) => /^\d+$/.test(name));
    }
    if (directory === null) {
      return null;
    }
    const day = directory;
    const names = (yield* fs.readDirectory(day)).filter((name) => name.endsWith(".jsonl"));
    const files = yield* Effect.forEach(names, (name) =>
      fs.stat(path.join(day, name)).pipe(
        Effect.map((info) => ({
          path: path.join(day, name),
          mtime: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
        })),
      ),
    );
    const newest = files.toSorted((left, right) => right.mtime - left.mtime)[0];
    if (newest === undefined) {
      return null;
    }
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(newest.path);
        const size = Number((yield* file.stat).size);
        const length = Math.min(size, CODEX_TAIL_BYTES);
        yield* file.seek(BigInt(size - length), "start");
        const bytes = yield* file.readAlloc(length);
        return Option.match(bytes, {
          onNone: () => null,
          onSome: (value) => new TextDecoder().decode(value),
        });
      }),
    );
  });

  const runJson = (command: string, args: ReadonlyArray<string>) =>
    processRunner.run({ command, args, timeout: "30 seconds" }).pipe(
      Effect.map((output) => (output.code === 0 ? output.stdout : null)),
      Effect.orElseSucceed(() => null),
    );

  const pollCswap = Effect.gen(function* () {
    const stdout = yield* runJson("cswap", ["list", "--json"]);
    const parsed = stdout === null ? null : Option.getOrNull(decodeJson(stdout));
    const rows = parseCswapList(parsed).map((account) =>
      row({
        instanceId: `cswap-${account.number}`,
        driver: "claudeAgent",
        label: account.email,
        detail: account.active ? "active" : undefined,
        cswapAccount: account.number,
        active: account.active,
        state: account.state,
      }),
    );
    yield* agentLimits.setPolled("cswap", rows);
  });

  const pollCodex = Effect.gen(function* () {
    const tail = yield* readNewestCodexSessionTail.pipe(Effect.orElseSucceed(() => null));
    const { state, planType } =
      tail === null ? { state: EMPTY_LIMIT_STATE, planType: null } : parseCodexSessionLimits(tail);
    yield* agentLimits.setPolled(
      "codex-session",
      state === EMPTY_LIMIT_STATE
        ? []
        : [
            row({
              instanceId: "codex",
              driver: "codex",
              label: "ChatGPT",
              detail: planType === null ? undefined : `${capitalize(planType)} plan`,
              state,
            }),
          ],
    );
  });

  const pollCursor = Effect.gen(function* () {
    const stdout = yield* runJson("cursor-agent", ["about"]);
    const tier = stdout === null ? null : parseCursorAboutTier(stdout);
    yield* agentLimits.setPolled(
      "cursor",
      tier === null
        ? []
        : [
            row({
              instanceId: "cursor",
              driver: "cursor",
              label: "Cursor",
              detail: `${tier} plan · no usage meter`,
              state: EMPTY_LIMIT_STATE,
            }),
          ],
    );
  });

  for (const [poll, interval] of [
    [pollCswap, CSWAP_INTERVAL],
    [pollCodex, CODEX_INTERVAL],
    [pollCursor, CURSOR_INTERVAL],
  ] as const) {
    yield* poll.pipe(Effect.repeat(Schedule.spaced(interval)), Effect.forkScoped);
  }

  const switchClaudeAccount = (cswapAccount: number) =>
    processRunner
      .run({ command: "cswap", args: ["switch", String(cswapAccount)], timeout: "30 seconds" })
      .pipe(
        Effect.map((output) => output.code === 0),
        Effect.orElseSucceed(() => false),
        Effect.tap(() => pollCswap),
        Effect.map((switched) => ({ switched })),
      );

  return LocalLimitSources.of({ switchClaudeAccount });
});

export const layer = Layer.effect(LocalLimitSources, make);
