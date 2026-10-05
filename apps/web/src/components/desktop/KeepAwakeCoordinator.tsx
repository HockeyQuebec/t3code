import { useEffect } from "react";

import { useScheduledTurns } from "../../lib/scheduledTurnsState";

/**
 * Asks the desktop shell to hold off idle sleep while any scheduled turn is
 * pending, so work queued for later fires on time. Renders nothing.
 */
export function KeepAwakeCoordinator() {
  const setKeepAwake = window.desktopBridge?.setKeepAwake;
  const scheduled = useScheduledTurns().data?.scheduled;
  const hasPending = scheduled?.some((turn) => turn.status === "pending") ?? false;

  useEffect(() => {
    if (!setKeepAwake) return;
    void setKeepAwake(hasPending).catch(() => undefined);
  }, [setKeepAwake, hasPending]);

  return null;
}
