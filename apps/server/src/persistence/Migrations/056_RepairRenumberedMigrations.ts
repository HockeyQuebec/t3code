import * as Effect from "effect/Effect";

import ProjectionTurnsKeysetIndex from "./037_ProjectionTurnsKeysetIndex.ts";
import ProjectionThreadsPinOrderKey from "./038_ProjectionThreadsPinOrderKey.ts";

/**
 * Databases created by the night-runner builds recorded ids 37 and 38 for the
 * scheduled-turn tables (now 54 and 55), so the migrator treats upstream's 37
 * and 38 as already applied. Both are idempotent, so running them again here
 * is a no-op everywhere else.
 */
export default Effect.gen(function* () {
  yield* ProjectionTurnsKeysetIndex;
  yield* ProjectionThreadsPinOrderKey;
});
