import type { ProviderUsageLimitsUpdate, ServerProvider } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderVersionSource } from "./versionAdvisory.ts";

export interface ManagedServerProvider {
  /** Read-only release metadata for version notices and explicit refreshes. */
  readonly getVersionSource: (options?: {
    readonly fresh?: boolean;
  }) => Effect.Effect<ProviderVersionSource>;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
  /**
   * Fold a runtime rate-limit update into the published snapshot without
   * waiting for the next status probe. Sparse: windows merge by id and an
   * update with no usable window leaves the snapshot untouched.
   */
  readonly applyUsageLimits: (
    update: ProviderUsageLimitsUpdate & { readonly checkedAt: string },
  ) => Effect.Effect<void>;
}
