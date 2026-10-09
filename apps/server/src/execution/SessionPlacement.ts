import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ProviderAdapterV2Shape } from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Native adapter tests retain upstream sharing; cloud application layers select per-thread. */
export const SessionPlacement = Context.Reference<"shared-when-supported" | "per-thread">(
  "t3/execution/SessionPlacement",
  { defaultValue: () => "shared-when-supported" },
);

export const providerSessionIdFor = (input: {
  adapter: ProviderAdapterV2Shape;
  providerInstanceId: ProviderInstanceId;
  threadId: ThreadId;
}) =>
  Effect.gen(function* () {
    const ids = yield* IdAllocator.IdAllocatorV2;
    const placement = yield* SessionPlacement;
    if (placement === "per-thread")
      return yield* ids.allocate.providerSession({
        providerInstanceId: input.providerInstanceId,
        threadId: input.threadId,
      });
    const capabilities = yield* input.adapter.getCapabilities();
    return capabilities.sessions.supportsMultipleProviderThreadsPerSession
      ? ids.derive.providerSession({ providerInstanceId: input.providerInstanceId })
      : yield* ids.allocate.providerSession({
          providerInstanceId: input.providerInstanceId,
          threadId: input.threadId,
        });
  });
