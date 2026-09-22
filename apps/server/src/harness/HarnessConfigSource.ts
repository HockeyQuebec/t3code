/**
 * Where a repository's harness workflows come from, and what text they are.
 *
 * A workflow config describes how someone wants work done, which is a property
 * of the person more than of the checkout — so one global file serves every
 * repository. A repository may still declare its own; when it does, the two are
 * merged and the repository wins table by table, so a checkout that wants one
 * extra workflow writes one table instead of a copy of the whole file.
 *
 * Both the catalog (which lists workflows) and the adapter (which hands a file
 * to agent-harness) resolve through here, so the run can never see a different
 * set of workflows than the picker showed.
 */
import {
  WORKFLOW_CONFIG_NAMES,
  globalHarnessConfigCandidates,
} from "@t3tools/shared/harnessWorkflow";
import { mergeHarnessConfigText } from "@t3tools/shared/harnessConfigMerge";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export type HarnessConfigScopeName = "repository" | "global" | "merged";

export type HarnessConfigSource =
  | { readonly kind: "none" }
  | { readonly kind: "unreadable"; readonly configPath: string }
  | {
      readonly kind: "ok";
      /** The file to name when talking to the user: the one they would edit. */
      readonly configPath: string;
      readonly scope: HarnessConfigScopeName;
      /** The effective config text, already merged when both files exist. */
      readonly toml: string;
      readonly repositoryPath: string | null;
      readonly globalPath: string | null;
      /** Table keys the repository replaced, e.g. `workflows.claude_team`. */
      readonly overridden: ReadonlyArray<string>;
    };

/** True only for a path that exists and is a regular file. */
function isFile(
  fileSystem: FileSystem.FileSystem,
  candidate: string,
): Effect.Effect<boolean, never, never> {
  return fileSystem.stat(candidate).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.orElseSucceed(() => false),
  );
}

export function walkUpForConfig(
  startPath: string,
  fileSystem: FileSystem.FileSystem,
  pathModule: Path.Path,
): Effect.Effect<string | undefined, never, never> {
  return Effect.gen(function* () {
    let current = startPath;
    let levels = 0;
    const maxLevels = 8;

    while (levels < maxLevels) {
      for (const configName of WORKFLOW_CONFIG_NAMES) {
        const configPath = pathModule.join(current, configName);
        if (yield* isFile(fileSystem, configPath)) {
          return configPath;
        }
      }

      // A checkout boundary: a config above it belongs to something else.
      const gitPath = pathModule.join(current, ".git");
      const hasGit = yield* fileSystem.stat(gitPath).pipe(
        Effect.map(() => true),
        Effect.orElseSucceed(() => false),
      );
      if (hasGit) {
        return undefined;
      }

      const parent = pathModule.dirname(current);
      if (parent === current) {
        return undefined;
      }

      current = parent;
      levels++;
    }

    return undefined;
  });
}

/**
 * The first global config that exists. See `globalHarnessConfigCandidates` for
 * what order it searches and why.
 */
export function findGlobalConfig(
  fileSystem: FileSystem.FileSystem,
  pathModule: Path.Path,
  environment: Readonly<Record<string, string | undefined>>,
  harnessHome: string,
): Effect.Effect<string | undefined, never, never> {
  return Effect.gen(function* () {
    const candidates = globalHarnessConfigCandidates({
      environment,
      harnessHome,
      join: (...segments) => pathModule.join(...segments),
    });
    for (const candidate of candidates) {
      if (yield* isFile(fileSystem, candidate)) {
        return candidate;
      }
    }
    return undefined;
  });
}

export function resolveHarnessConfigSource(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathModule: Path.Path;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly harnessHome: string;
}): Effect.Effect<HarnessConfigSource, never, never> {
  const { fileSystem, pathModule, environment, cwd, harnessHome } = input;
  return Effect.gen(function* () {
    const repositoryPath = yield* walkUpForConfig(cwd, fileSystem, pathModule);
    const globalPath = yield* findGlobalConfig(fileSystem, pathModule, environment, harnessHome);
    // A repository whose own config *is* the global one has nothing to merge.
    const globalIsRepository = globalPath !== undefined && globalPath === repositoryPath;

    if (repositoryPath === undefined && globalPath === undefined) {
      return { kind: "none" } as const;
    }

    const read = (path: string) =>
      fileSystem.readFileString(path).pipe(
        Effect.map((text): string | null => text),
        Effect.orElseSucceed(() => null),
      );

    if (repositoryPath === undefined || globalIsRepository) {
      const path = (repositoryPath ?? globalPath) as string;
      const scope: HarnessConfigScopeName = repositoryPath === undefined ? "global" : "repository";
      const toml = yield* read(path);
      if (toml === null) {
        return { kind: "unreadable", configPath: path } as const;
      }
      return {
        kind: "ok",
        configPath: path,
        scope,
        toml,
        repositoryPath: repositoryPath ?? null,
        globalPath: repositoryPath === undefined ? path : null,
        overridden: [],
      } as const;
    }

    const repositoryToml = yield* read(repositoryPath);
    if (repositoryToml === null) {
      return { kind: "unreadable", configPath: repositoryPath } as const;
    }

    if (globalPath === undefined) {
      return {
        kind: "ok",
        configPath: repositoryPath,
        scope: "repository",
        toml: repositoryToml,
        repositoryPath,
        globalPath: null,
        overridden: [],
      } as const;
    }

    // A global config that cannot be read is not worth failing the repository's
    // own over; the checkout's file alone is still a usable config.
    const globalToml = yield* read(globalPath);
    if (globalToml === null) {
      return {
        kind: "ok",
        configPath: repositoryPath,
        scope: "repository",
        toml: repositoryToml,
        repositoryPath,
        globalPath: null,
        overridden: [],
      } as const;
    }

    const merged = mergeHarnessConfigText(globalToml, repositoryToml);
    return {
      kind: "ok",
      configPath: repositoryPath,
      scope: "merged",
      toml: merged.toml,
      repositoryPath,
      globalPath,
      overridden: merged.overridden,
    } as const;
  });
}
