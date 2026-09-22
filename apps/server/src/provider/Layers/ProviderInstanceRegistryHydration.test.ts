import { ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

describe("deriveProviderInstanceConfigMap", () => {
  it("gives every built-in driver a default instance", () => {
    const settings = decodeSettings({});
    const map = deriveProviderInstanceConfigMap(settings);

    // A driver that is in BUILT_IN_DRIVERS but gets no instance is invisible
    // everywhere in the UI, which is how the harness driver went missing.
    for (const driver of BUILT_IN_DRIVERS) {
      expect(Object.values(map).some((entry) => entry.driver === driver.driverKind)).toBe(true);
    }
  });

  it("keeps an explicit providerInstances entry over the synthesized one", () => {
    const settings = decodeSettings({
      providerInstances: {
        codex: { driver: "codex", config: { marker: "explicit" } },
      },
    });

    const map = deriveProviderInstanceConfigMap(settings);
    const codex = Object.entries(map).find(([instanceId]) => instanceId === "codex")?.[1];
    expect(codex?.config).toEqual({ marker: "explicit" });
  });
});
