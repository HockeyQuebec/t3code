import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DesktopMenuBarStateSchema, type DesktopMenuBarState } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { SET_MENU_BAR_STATE_CHANNEL } from "../channels.ts";

// 25x16pt "T3" template images at @2x, with and without an attention dot.
// Template images let macOS tint them for light and dark menu bars.
const IDLE_ICON =
  "iVBORw0KGgoAAAANSUhEUgAAADIAAAAgCAYAAABQISshAAAAAXNSR0IArs4c6QAAADhlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAAqACAAQAAAABAAAAMqADAAQAAAABAAAAIAAAAABMI0lzAAAB6ElEQVRYCe1XvyuGURT+/AgDJUzKSAwWGZgMJoONiVIWikEZWPwDzDaTyGBQDAaLkr9ABpKShYTyY0Dieeo9dbvd737vd398KffU03vPufec7zzn3Pve9ysUkqQKpAr8qwr8gG0IXGRV2/WIt+xS+WoXp7/ok4hE6soX4p66xK7KnNqKOLfALvteljxj0CWK9vyGznl22tbtZsyfAN2AKlNQNlVDqDEJ6i+BR8/gdfA/NsRd8YxrdQ9NhDtgx0Biw5pFgMnQRFYNJA5hqw2QqzVESCLzBhK3sPE3oktIIvfIVj9v1D+BPWAAiCaVICLk+MZbisWkkkSE0KQLGblHivmSyIM2+QS9VbPlUcewqAHg/cJ7pB8YB2hThVuwA+DlGExCdsSUVC+M74B0Q57DpsU2m+32tfmFmjtDoH1DsE6DzWqKSYQ3eB5hF3Qp+16JRYTfYtfANFCvZ6noPRiPKroML2WQ9xnrsG8hgYksCX6bHQD8qr0BXgCevSFgFmgCVOHLpB34UI2+Y5fDzirzTpCDW+5zwTdpk78LkTUPEuxkqV1iyrOkzYVIDaLOAFdA3m68Yu0i4EyilGMjgq8DqrxBmVMNlvEg5kaAPoBbjn/UeCa4/++Ac+AI2AZ4NpKkCqQKpArYK/ALjm/eIBRH4hcAAAAASUVORK5CYII=";
const ATTENTION_ICON =
  "iVBORw0KGgoAAAANSUhEUgAAADIAAAAgCAYAAABQISshAAAAAXNSR0IArs4c6QAAADhlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAAqACAAQAAAABAAAAMqADAAQAAAABAAAAIAAAAABMI0lzAAACI0lEQVRYCe2YPSwEQRTH10dQkPiqJEqXKDTiEiqFSqGjIgoNCYVEQaNVUOuURKGQUCgkF41KeREhIhENEQofBSL8/3HvMpnMzu7N7p67ZF/yy8y8ndl5/zczO4fnpZZmwDUDYxiYA68FWKevqmwN0f74wGdVYcy6nwjxF1dGHFHLy0Jq9kJM7jfXipZebiG/vuLP1WqDKrGZDRFUthqEhNDheZUm5AtRn2qRn2ltU7PYpxNPTWTgl30o5bNPX45vAzQmqN4C+14AeaeU0/DpVtJh1wdLmxPKJFI+yUPHsgHjToC8T8pVy/v4iZV+eslngRa3kBrMuAv0YLYCI/m7/JwvxLiFrBtEHMHHbZioxSlkAZHqK3EHH+dI3OIU8oBodSFsf4J9MAgSs3IIEXHfULGclJJyChFBUy5i+BWxGYU8ah14j3RovjDNcXRqArxjWsEAmAD0qcYt2A14OcZmca6IKag+ON+BrIaUI6bONt9//0TJI7gDQ4A9Bp/VlaQQ3uBhjKugW8n3SlJCMojsBsyARj1Kpd2LevGPIsV/pdRDVZM67NuYfbIQAX+bHQL+qr0FL4BnbxjMgRagGj8mXeBDdUatuxx2Zpl3ghzcUsvFqEGbxrsI2YgggisZtEtMcQb6XITU4a2z4BqEXQ3+i2cJOIsIGtiMl28C1d7QmFcdlvoQno2CfsAt1w54Jrj/78E5OAY7gGcjtTQDaQbSDNgz8AsjaBY+J311awAAAABJRU5ErkJggg==";

function templateIcon(base64: string): Electron.NativeImage {
  const image = Electron.nativeImage.createFromBuffer(Buffer.from(base64, "base64"), {
    scaleFactor: 2,
  });
  image.setTemplateImage(true);
  return image;
}

/**
 * The macOS menu bar item. The renderer pushes a pre-formatted state whenever
 * thread status changes; clicking a thread row hands its action back to the
 * renderer as a menu action, revealing the window first.
 */
export const installMenuBar = Effect.fn("desktop.ipc.installMenuBar")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const platform = yield* HostProcessPlatform;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const dispatch = (action: string) =>
    void runPromise(desktopWindow.dispatchMenuAction(action).pipe(Effect.ignoreCause));
  const open = () => void runPromise(desktopWindow.activate.pipe(Effect.ignoreCause));

  let tray: Electron.Tray | null = null;
  let icons: { idle: Electron.NativeImage; attention: Electron.NativeImage } | null = null;
  // The renderer that last pushed state. Its window can close while the app
  // keeps running, and its thread list must not outlive it.
  let owner: Electron.WebContents | null = null;

  const destroy = () => {
    tray?.destroy();
    tray = null;
  };

  const render = (state: DesktopMenuBarState) => {
    icons ??= { idle: templateIcon(IDLE_ICON), attention: templateIcon(ATTENTION_ICON) };
    tray ??= new Electron.Tray(icons.idle);
    tray.setImage(state.attention ? icons.attention : icons.idle);
    tray.setTitle(state.title, { fontType: "monospacedDigit" });
    tray.setToolTip(state.tooltip);
    const template: Electron.MenuItemConstructorOptions[] = [];
    for (const section of state.sections) {
      if (template.length > 0) template.push({ type: "separator" });
      template.push({ label: section.label, enabled: false });
      for (const item of section.items) {
        const { action } = item;
        template.push(
          action === null
            ? { label: item.label, enabled: false }
            : { label: item.label, click: () => dispatch(action) },
        );
      }
    }
    if (template.length > 0) template.push({ type: "separator" });
    template.push(
      { label: "Open T3 Code", click: open },
      { label: "Menu Bar Settings…", click: () => dispatch("open-menu-bar-settings") },
      { type: "separator" },
      { role: "quit", label: "Quit T3 Code" },
    );
    tray.setContextMenu(Electron.Menu.buildFromTemplate(template));
  };

  const release = () => {
    owner = null;
    if (!tray) return;
    render({ title: "", attention: false, tooltip: "T3 Code", sections: [] });
  };

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_MENU_BAR_STATE_CHANNEL,
      payload: Schema.NullOr(DesktopMenuBarStateSchema),
      result: Schema.Void,
      handler: (state, event) =>
        Effect.sync(() => {
          if (platform !== "darwin") return;
          const sender = event ? Electron.webContents.fromId(event.sender.id) : undefined;
          if (sender && sender !== owner) {
            owner = sender;
            sender.once("destroyed", () => {
              if (owner === sender) release();
            });
          }
          if (state === null) destroy();
          else render(state);
        }),
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(destroy));
});
