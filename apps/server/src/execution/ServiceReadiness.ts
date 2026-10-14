// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Readiness for Node HTTP and Playwright transport boundaries.
import * as NodeTimersPromises from "node:timers/promises";

/** Probe only a read-only health endpoint. Never replay the operation waiting for it. */
export async function waitForService(
  url: URL,
  options: {
    signal: AbortSignal;
    accept?: (response: Response) => Promise<boolean>;
  },
): Promise<void> {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]);
  while (true) {
    signal.throwIfAborted();
    let response: Response | undefined;
    try {
      response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
        redirect: "manual",
      });
    } catch (error) {
      signal.throwIfAborted();
      // fetch rejects network failures; parsing and validation stay outside this retry.
      if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
    }
    if (response) {
      try {
        if (response.ok && (!options.accept || (await options.accept(response)))) return;
        if (!response.ok && response.status !== 503)
          throw new Error(`Service readiness failed with HTTP ${response.status}`);
      } finally {
        if (!response.bodyUsed) await response.body?.cancel();
      }
    }
    await NodeTimersPromises.setTimeout(250, undefined, { signal });
  }
}
