import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { desktopDir, resolveElectronLaunchCommand } from "./electron-launcher.mjs";

// Every artifact the packaged-style launch needs before Electron is worth
// starting. `vp pack` rebuilds only the Electron bundles in dist-electron and
// looks like a full build while doing so, so a developer who runs it on its own
// keeps a stale (or entirely missing) server build and renderer bundle. The
// main process still comes up in that state and the window simply renders
// nothing, which is far harder to diagnose than a message on stdout.
const requiredArtifacts = [
  "dist-electron/main.cjs",
  "dist-electron/preload.cjs",
  "../server/dist/bin.mjs",
  "../server/dist/client/index.html",
];
const buildCommand = "pnpm build:desktop";

function findMissingArtifacts() {
  return requiredArtifacts.filter(
    (relativePath) => !NodeFS.existsSync(NodePath.resolve(desktopDir, relativePath)),
  );
}

function tcpPortIsListening(host, port, connectTimeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = NodeNet.createConnection({ host, port });
    let settled = false;

    const finish = (listening) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };

    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.setTimeout(connectTimeoutMs);
  });
}

// A VITE_DEV_SERVER_URL in the environment puts the main process into
// development mode, where the custom protocol proxies every renderer request to
// that origin instead of to the backend. The value outlives the dev session that
// produced it (the macOS launcher bakes the last one into the app bundle's
// shim), so an origin nobody is listening on turns into a blank window whose
// only trace is an ERR_UNEXPECTED buried in the main process log.
async function findDeadDevServerUrl() {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
  if (!devServerUrl) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(devServerUrl);
  } catch {
    return devServerUrl;
  }

  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isInteger(port) || port <= 0) {
    return devServerUrl;
  }

  return (await tcpPortIsListening(parsed.hostname, port)) ? null : devServerUrl;
}

const missingArtifacts = findMissingArtifacts();
if (missingArtifacts.length > 0) {
  console.error(
    [
      "[desktop-start] Refusing to launch: the desktop build is incomplete.",
      ...missingArtifacts.map((relativePath) => `  missing: ${relativePath}`),
      `Run \`${buildCommand}\` from the repo root, then start the app again.`,
    ].join("\n"),
  );
  process.exit(1);
}

const deadDevServerUrl = await findDeadDevServerUrl();
if (deadDevServerUrl) {
  console.error(
    [
      `[desktop-start] Refusing to launch: VITE_DEV_SERVER_URL points at ${deadDevServerUrl}, which is not accepting connections.`,
      "The renderer is proxied to that origin in development mode, so the window would open blank.",
      "Run `pnpm dev:desktop` from the repo root to start the dev server with the app,",
      "or unset VITE_DEV_SERVER_URL to run against the built renderer instead.",
    ].join("\n"),
  );
  process.exit(1);
}

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const electronCommand = resolveElectronLaunchCommand(["dist-electron/main.cjs"]);
const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  stdio: "inherit",
  cwd: desktopDir,
  env: childEnv,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
