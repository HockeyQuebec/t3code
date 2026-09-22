import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Finding a Whisper CLI, and ffmpeg beside it.
 *
 * Both are ordinary `PATH` lookups, but the configured name may also be an
 * absolute path or a `~`-relative one: people commonly point this at a
 * virtualenv's copy rather than installing one globally.
 */

function isExecutable(
  fileSystem: FileSystem.FileSystem,
  candidate: string,
): Effect.Effect<boolean> {
  return fileSystem.access(candidate, { ok: true }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
}

export function expandHome(candidate: string, home: string | undefined): string {
  if (home === undefined || !(candidate === "~" || candidate.startsWith("~/"))) {
    return candidate;
  }
  return candidate === "~" ? home : `${home}/${candidate.slice(2)}`;
}

/**
 * Resolve an executable to an absolute path, or null when there is none.
 *
 * A name containing a separator is taken as a path and never searched for on
 * `PATH` — otherwise a typo'd path would silently resolve to some unrelated
 * binary with the same basename.
 */
export function resolveExecutable(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathModule: Path.Path;
  readonly name: string;
  readonly pathEnv: string;
  readonly home?: string | undefined;
  readonly platform: NodeJS.Platform;
}): Effect.Effect<string | null> {
  return Effect.gen(function* () {
    const { fileSystem, pathModule } = input;
    const name = expandHome(input.name.trim(), input.home);
    if (name.length === 0) {
      return null;
    }

    if (name.includes("/") || name.includes("\\")) {
      const resolved = pathModule.resolve(name);
      return (yield* isExecutable(fileSystem, resolved)) ? resolved : null;
    }

    for (const dir of input.pathEnv.split(input.platform === "win32" ? ";" : ":")) {
      if (dir.length === 0) continue;
      const candidate = pathModule.join(dir, name);
      if (yield* isExecutable(fileSystem, candidate)) {
        return candidate;
      }
    }
    return null;
  });
}
