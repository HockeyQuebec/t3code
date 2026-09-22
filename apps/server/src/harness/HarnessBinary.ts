import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Finding the `agent-harness` executable, and working out how to run it.
 *
 * Two installs are common and behave differently. An installed console script
 * is self-contained and runs from anywhere. A source checkout ships a `harness`
 * shell launcher that does `python -m agent_harness.cli`, which only resolves
 * when the checkout root is importable — so when the executable turns out to
 * live beside an `agent_harness` package, that root is put on `PYTHONPATH`.
 * Without this, a perfectly good checkout reports "not installed".
 */

export interface ResolvedHarnessBinary {
  readonly executable: string;
  /**
   * Environment the launcher needs, empty for an installed console script.
   * Merged over the inherited environment at spawn time.
   */
  readonly env: Readonly<Record<string, string>>;
}

/** Set this to point at a harness that is not on `PATH`. */
export const HARNESS_BIN_ENV = "AGENT_HARNESS_BIN";

/** Set this to keep runs and worktrees somewhere other than the default. */
export const HARNESS_HOME_ENV = "AGENT_HARNESS_HOME";

/**
 * Where runs and worktrees are kept, matching the CLI's own default. A state
 * directory — never the executable.
 */
export function resolveHarnessHome(input: {
  readonly pathModule: Path.Path;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly override?: string | undefined;
}): string {
  const explicit = input.override?.trim() || input.environment[HARNESS_HOME_ENV]?.trim();
  if (explicit) {
    return explicit;
  }
  const home = input.environment.HOME ?? input.environment.USERPROFILE ?? ".";
  return input.pathModule.join(home, ".local", "share", "agent-harness");
}

function isExecutable(
  fileSystem: FileSystem.FileSystem,
  candidate: string,
): Effect.Effect<boolean> {
  return fileSystem.access(candidate, { ok: true }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
}

/**
 * A source checkout is recognised by an `agent_harness` package sitting beside
 * the launcher; that directory is what has to be importable.
 */
function checkoutRoot(
  fileSystem: FileSystem.FileSystem,
  pathModule: Path.Path,
  executable: string,
): Effect.Effect<string | null> {
  return Effect.gen(function* () {
    const root = pathModule.dirname(executable);
    const packageDir = pathModule.join(root, "agent_harness");
    const exists = yield* fileSystem.stat(packageDir).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
    return exists ? root : null;
  });
}

/**
 * Resolve the harness executable, or null when there is none to run.
 *
 * Precedence: an explicit `AGENT_HARNESS_BIN` override, then `PATH`.
 */
export function resolveHarnessBinary(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathModule: Path.Path;
  readonly pathEnv: string;
  readonly platform: NodeJS.Platform;
  readonly override?: string | undefined;
  readonly binaryName?: string;
}): Effect.Effect<ResolvedHarnessBinary | null> {
  return Effect.gen(function* () {
    const { fileSystem, pathModule, platform } = input;
    const name = input.binaryName ?? "agent-harness";

    const withEnv = (executable: string) =>
      Effect.map(
        checkoutRoot(fileSystem, pathModule, executable),
        (root): ResolvedHarnessBinary => ({
          executable,
          env: root === null ? {} : { PYTHONPATH: root },
        }),
      );

    const override = input.override?.trim();
    if (override !== undefined && override.length > 0) {
      const resolved = pathModule.resolve(override);
      return (yield* isExecutable(fileSystem, resolved)) ? yield* withEnv(resolved) : null;
    }

    for (const dir of input.pathEnv.split(platform === "win32" ? ";" : ":")) {
      if (dir.length === 0) {
        continue;
      }
      const candidate = pathModule.join(dir, name);
      if (yield* isExecutable(fileSystem, candidate)) {
        return yield* withEnv(candidate);
      }
    }
    return null;
  });
}
