import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../DesktopIpc.ts";
import { SET_KEEP_AWAKE_CHANNEL } from "../channels.ts";

/**
 * Keeps the machine from idle-sleeping while the renderer says scheduled work
 * is pending, so turns queued for tonight fire on time. This cannot wake a
 * machine that is already asleep, and lid-close sleep still wins on laptops.
 * The blocker is dropped when the renderer that asked for it goes away.
 */
export const installKeepAwake = Effect.fn("desktop.ipc.installKeepAwake")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;

  let blockerId: number | null = null;
  let owner: Electron.WebContents | null = null;

  const release = () => {
    if (blockerId !== null && Electron.powerSaveBlocker.isStarted(blockerId)) {
      Electron.powerSaveBlocker.stop(blockerId);
    }
    blockerId = null;
  };

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_KEEP_AWAKE_CHANNEL,
      payload: Schema.Boolean,
      result: Schema.Void,
      handler: (keepAwake, event) =>
        Effect.sync(() => {
          const sender = event ? Electron.webContents.fromId(event.sender.id) : undefined;
          if (sender && sender !== owner) {
            owner = sender;
            sender.once("destroyed", () => {
              if (owner !== sender) return;
              owner = null;
              release();
            });
          }
          if (!keepAwake) return release();
          if (blockerId === null) {
            blockerId = Electron.powerSaveBlocker.start("prevent-app-suspension");
          }
        }),
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(release));
});
