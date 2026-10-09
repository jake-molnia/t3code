import * as Effect from "effect/Effect";

/** Capture the worker's services once for Node HTTP callbacks; no runtime is created per request. */
export const captureRunPromise = Effect.map(Effect.context<never>(), Effect.runPromiseWith);
