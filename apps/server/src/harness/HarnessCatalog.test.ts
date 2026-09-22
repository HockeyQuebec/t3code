import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";

import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";

import { HarnessCatalogService, layer } from "./HarnessCatalog.ts";

// The catalog needs the platform services to build, and the tests need them
// too — so the dependency is provided *and* merged, in that direction.
const testLayer = layer.pipe(Layer.provideMerge(NodeServices.layer));

/**
 * Global-config lookup reads HOME and XDG_CONFIG_HOME, so a test that does not
 * pin them would pass or fail on whether the developer running it happens to
 * keep a global harness config.
 */
const isolatedEnvironment = (pathModule: Path.Path, home: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  XDG_CONFIG_HOME: pathModule.join(home, ".config"),
  AGENT_HARNESS_HOME: pathModule.join(home, ".local", "share", "agent-harness"),
});

const MINIMAL_CONFIG = `version = 1

[agents.solo]
provider = "claude"
mode = "write"

[workflows.global_only]
entrypoint = "start"

[workflows.global_only.nodes.start]
kind = "agent"
agent = "solo"
`;

it.effect("returns noConfig when no config file is found", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathMod = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-no-config-" });

    const service = yield* HarnessCatalogService;
    const result = yield* service
      .read({ cwd: root })
      .pipe(Effect.provideService(HostProcessEnvironment, isolatedEnvironment(pathMod, root)));

    assert.equal(Option.isNone(result.unavailable), false);
    assert.equal(Option.getOrThrow(result.unavailable), "noConfig");
    assert.equal(result.workflows.length, 0);
    assert.equal(Option.isNone(result.configPath), true);
    assert.equal(Option.isNone(result.configScope), true);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("falls back to the global config when the repository declares none", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathMod = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-global-home-" });
    const repo = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-global-repo-" });

    const globalDirectory = pathMod.join(home, ".config", "agent-harness");
    yield* fs.makeDirectory(globalDirectory, { recursive: true });
    const globalPath = pathMod.join(globalDirectory, "config.toml");
    yield* fs.writeFileString(globalPath, MINIMAL_CONFIG);

    const service = yield* HarnessCatalogService;
    const result = yield* service
      .read({ cwd: repo })
      .pipe(Effect.provideService(HostProcessEnvironment, isolatedEnvironment(pathMod, home)));

    assert.equal(Option.isNone(result.unavailable), true);
    assert.equal(Option.getOrThrow(result.configPath), globalPath);
    assert.equal(Option.getOrThrow(result.configScope), "global");
    assert.deepEqual(
      result.workflows.map((workflow) => workflow.name),
      ["global_only"],
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("adds a repository's workflows to the global ones", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathMod = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-merge-home-" });
    const repo = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-merge-repo-" });

    const globalDirectory = pathMod.join(home, ".config", "agent-harness");
    yield* fs.makeDirectory(globalDirectory, { recursive: true });
    yield* fs.writeFileString(pathMod.join(globalDirectory, "config.toml"), MINIMAL_CONFIG);

    const repositoryPath = pathMod.join(repo, ".agent-harness.toml");
    yield* fs.writeFileString(
      repositoryPath,
      MINIMAL_CONFIG.replace("[workflows.global_only]", "[workflows.repo_only]").replace(
        "[workflows.global_only.nodes.start]",
        "[workflows.repo_only.nodes.start]",
      ),
    );

    const service = yield* HarnessCatalogService;
    const result = yield* service
      .read({ cwd: repo })
      .pipe(Effect.provideService(HostProcessEnvironment, isolatedEnvironment(pathMod, home)));

    // The repository's file is the one a person would edit, so it is the one
    // named — but both sets of workflows are offered.
    assert.equal(Option.getOrThrow(result.configPath), repositoryPath);
    assert.equal(Option.getOrThrow(result.configScope), "merged");
    assert.deepEqual(result.workflows.map((workflow) => workflow.name).sort(), [
      "global_only",
      "repo_only",
    ]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("lets a repository redefine a global workflow of the same name", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathMod = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-shadow-home-" });
    const repo = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-shadow-repo-" });

    const globalDirectory = pathMod.join(home, ".config", "agent-harness");
    yield* fs.makeDirectory(globalDirectory, { recursive: true });
    yield* fs.writeFileString(pathMod.join(globalDirectory, "config.toml"), MINIMAL_CONFIG);

    // Same workflow name, a different agent behind it: the repository's
    // definition has to replace the global one whole, not blend with it.
    yield* fs.writeFileString(
      pathMod.join(repo, ".agent-harness.toml"),
      `version = 1

[agents.local]
provider = "codex"
mode = "write"

[workflows.global_only]
entrypoint = "start"

[workflows.global_only.nodes.start]
kind = "agent"
agent = "local"
`,
    );

    const service = yield* HarnessCatalogService;
    const result = yield* service
      .read({ cwd: repo })
      .pipe(Effect.provideService(HostProcessEnvironment, isolatedEnvironment(pathMod, home)));

    assert.equal(Option.getOrThrow(result.configScope), "merged");
    assert.deepEqual(
      result.workflows.map((workflow) => workflow.name),
      ["global_only"],
    );
    const workflow = result.workflows[0];
    assert.ok(workflow);
    assert.deepEqual(workflow.drivers, [ProviderDriverKind.make("codex")]);
    // The global config's agent survives the merge even though its workflow
    // did not, so a repository may still reference it.
    assert.deepEqual(
      workflow.roles.map((role) => role.name),
      ["local"],
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("lets AGENT_HARNESS_CONFIG name a directory of workflows", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathMod = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-env-home-" });
    const repo = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-env-repo-" });
    const pointed = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-env-dir-" });

    const pointedPath = pathMod.join(pointed, ".agent-harness.toml");
    yield* fs.writeFileString(pointedPath, MINIMAL_CONFIG);

    const service = yield* HarnessCatalogService;
    const result = yield* service.read({ cwd: repo }).pipe(
      Effect.provideService(HostProcessEnvironment, {
        ...isolatedEnvironment(pathMod, home),
        AGENT_HARNESS_CONFIG: pointed,
      }),
    );

    assert.equal(Option.getOrThrow(result.configPath), pointedPath);
    assert.equal(Option.getOrThrow(result.configScope), "global");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("parses valid config and returns workflows with correct drivers", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathMod = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-harness-valid-config-",
    });

    const configContent = `
version = 1

[agents.planner]
provider = "claude"
mode = "read"
model = "claude-opus"

[agents.implementer]
provider = "cursor"
mode = "write"
model = "cursor-pro"

[workflows.plan_and_implement]
entrypoint = "plan"

[workflows.plan_and_implement.nodes.plan]
kind = "agent"
agent = "planner"
on_success = "implement"

[workflows.plan_and_implement.nodes.implement]
kind = "agent"
agent = "implementer"

[workflows.auto_claude]
entrypoint = "start"

[workflows.auto_claude.nodes.start]
kind = "agent"
agent = "planner"
`;

    const configPath = pathMod.join(root, ".agent-harness.toml");
    yield* fs.writeFileString(configPath, configContent);

    const service = yield* HarnessCatalogService;
    const result = yield* service
      .read({ cwd: root })
      .pipe(Effect.provideService(HostProcessEnvironment, isolatedEnvironment(pathMod, root)));

    // Should have workflows
    assert.equal(result.workflows.length, 2);

    // Check first workflow
    const planWorkflow = result.workflows[0];
    assert.ok(planWorkflow);
    assert.equal(planWorkflow.name, "plan_and_implement");
    assert.equal(planWorkflow.drivers.length, 2);
    assert.isTrue(planWorkflow.drivers.includes(ProviderDriverKind.make("claude")));
    assert.isTrue(planWorkflow.drivers.includes(ProviderDriverKind.make("cursor")));
    assert.equal(planWorkflow.stepCount, 2);

    // Check roles
    assert.equal(planWorkflow.roles.length, 2);
    const plannerRole = planWorkflow.roles.find(
      (r): r is (typeof planWorkflow.roles)[number] => r.name === "planner",
    );
    assert.ok(plannerRole);
    if (plannerRole) {
      assert.equal(plannerRole.driver, ProviderDriverKind.make("claude"));
      assert.equal(plannerRole.mode, "read");
      assert.equal(Option.getOrThrow(plannerRole.model), "claude-opus");
    }

    // Second workflow should be recommended if provider key matches
    const autoWorkflow = result.workflows[1];
    assert.ok(autoWorkflow);
    assert.equal(autoWorkflow.name, "auto_claude");

    // Config path should be set
    assert.equal(Option.isNone(result.configPath), false);

    // Should not have unavailable reason
    assert.equal(Option.isNone(result.unavailable), true);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("returns unreadableConfig for junk config content", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathMod = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-harness-junk-config-",
    });

    const configContent = `
This is not valid TOML at all!!!
[invalid syntax
key = = value
`;

    const configPath = pathMod.join(root, ".agent-harness.toml");
    yield* fs.writeFileString(configPath, configContent);

    const service = yield* HarnessCatalogService;
    const result = yield* service
      .read({ cwd: root })
      .pipe(Effect.provideService(HostProcessEnvironment, isolatedEnvironment(pathMod, root)));

    // Should have unreadableConfig error
    assert.equal(Option.isNone(result.unavailable), false);
    assert.equal(Option.getOrThrow(result.unavailable), "unreadableConfig");
    assert.equal(result.workflows.length, 0);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("walks up directory tree to find config in parent", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathMod = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-walk-up-" });

    const configContent = `
[agents.agent1]
provider = "claude"
mode = "read"

[workflows.workflow1]
entrypoint = "start"

[workflows.workflow1.nodes.start]
kind = "agent"
agent = "agent1"
`;

    const configPath = pathMod.join(root, ".agent-harness.toml");
    yield* fs.writeFileString(configPath, configContent);

    // Create a subdirectory
    const subdir = pathMod.join(root, "deep", "nested", "dir");
    yield* fs.makeDirectory(subdir, { recursive: true });

    const service = yield* HarnessCatalogService;
    const result = yield* service
      .read({ cwd: subdir })
      .pipe(Effect.provideService(HostProcessEnvironment, isolatedEnvironment(pathMod, root)));

    // Should find config in parent directory
    assert.equal(result.workflows.length, 1);
    const workflow1 = result.workflows[0];
    assert.ok(workflow1);
    assert.equal(workflow1.name, "workflow1");
    assert.equal(Option.isNone(result.unavailable), true);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("stops walking at .git directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathMod = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-harness-git-stop-",
    });

    // Create .git directory at root
    const gitDir = pathMod.join(root, ".git");
    yield* fs.makeDirectory(gitDir);

    // Create a subdirectory deep inside
    const subdir = pathMod.join(root, "deep", "nested", "dir");
    yield* fs.makeDirectory(subdir, { recursive: true });

    // No config file exists
    const service = yield* HarnessCatalogService;
    const result = yield* service
      .read({ cwd: subdir })
      .pipe(Effect.provideService(HostProcessEnvironment, isolatedEnvironment(pathMod, root)));

    // Should return noConfig because walking stops at .git
    assert.equal(Option.isNone(result.unavailable), false);
    assert.equal(Option.getOrThrow(result.unavailable), "noConfig");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("handles config files in subdirectories (.agent-harness/config.toml)", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathMod = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-harness-subdir-config-",
    });

    const configContent = `
[agents.test]
provider = "claude"
mode = "write"

[workflows.test_workflow]
entrypoint = "test"

[workflows.test_workflow.nodes.test]
kind = "agent"
agent = "test"
`;

    // Create config in subdirectory
    const configDir = pathMod.join(root, ".agent-harness");
    yield* fs.makeDirectory(configDir);
    const configPath = pathMod.join(configDir, "config.toml");
    yield* fs.writeFileString(configPath, configContent);

    const service = yield* HarnessCatalogService;
    const result = yield* service
      .read({ cwd: root })
      .pipe(Effect.provideService(HostProcessEnvironment, isolatedEnvironment(pathMod, root)));

    // Should find and parse config
    assert.equal(result.workflows.length, 1);
    const testWf = result.workflows[0];
    assert.ok(testWf);
    assert.equal(testWf.name, "test_workflow");
    assert.equal(Option.isNone(result.unavailable), true);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("maps workflow roles correctly with driver and mode", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathMod = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-harness-roles-" });

    const configContent = `
[agents.reviewer]
provider = "claude"
mode = "read"
timeout_seconds = 300

[agents.implementer]
provider = "cursor"
mode = "write"
reasoning = "chain-of-thought"

[workflows.review_and_code]
entrypoint = "review"

[workflows.review_and_code.nodes.review]
kind = "agent"
agent = "reviewer"
on_success = "code"

[workflows.review_and_code.nodes.code]
kind = "agent"
agent = "implementer"
`;

    const configPath = pathMod.join(root, ".agent-harness.toml");
    yield* fs.writeFileString(configPath, configContent);

    const service = yield* HarnessCatalogService;
    const result = yield* service
      .read({ cwd: root })
      .pipe(Effect.provideService(HostProcessEnvironment, isolatedEnvironment(pathMod, root)));

    assert.equal(result.workflows.length, 1);
    const workflow = result.workflows[0];
    assert.ok(workflow);

    // Both roles should be present
    assert.equal(workflow.roles.length, 2);

    // Check reviewer role
    const reviewerRole = workflow.roles.find(
      (r): r is (typeof workflow.roles)[number] => r.name === "reviewer",
    );
    assert.ok(reviewerRole);
    if (reviewerRole) {
      assert.equal(reviewerRole.driver, ProviderDriverKind.make("claude"));
      assert.equal(reviewerRole.mode, "read");
      assert.equal(Option.getOrThrow(reviewerRole.timeoutSeconds), 300);
    }

    // Check implementer role
    const implementerRole = workflow.roles.find(
      (r): r is (typeof workflow.roles)[number] => r.name === "implementer",
    );
    assert.ok(implementerRole);
    if (implementerRole) {
      assert.equal(implementerRole.driver, ProviderDriverKind.make("cursor"));
      assert.equal(implementerRole.mode, "write");
      assert.equal(Option.getOrThrow(implementerRole.reasoning), "chain-of-thought");
    }
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
