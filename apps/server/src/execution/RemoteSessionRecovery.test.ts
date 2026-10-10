import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as C from "@t3tools/contracts";
import type { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Recovery from "./RemoteSessionRecovery.ts";
import * as Runtime from "../agentRuntime/RuntimeClient.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as Runs from "../orchestration-v2/RunExecutionService.ts";
import * as Policy from "../orchestration-v2/RuntimePolicy.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";

it.effect("startup declines legacy parent and child sessions sharing one live sandbox", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const instanceId = C.ProviderInstanceId.make("codex");
    const identity = {
      workspaceId: "shared-workspace",
      allocationId: "one",
      generation: 1,
      podUid: "same-pod",
      incarnation: "same-worker",
      protocolVersion: 1,
    } satisfies ExecutionIdentity;
    let observations = 0,
      opens = 0;
    const layer = Recovery.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(Runtime.RuntimeClient)({
            enabled: true,
            sessionResidency: () => Effect.succeed(identity),
            observeThread: () =>
              Effect.sync(() => {
                observations++;
                throw new Error("legacy shared session must not reattach");
              }),
          }),
          Layer.mock(Projections.ProjectionStoreV2)({}),
          Layer.mock(Sessions.ProviderSessionManagerV2)({
            open: () =>
              Effect.sync(() => {
                opens++;
                throw new Error("legacy shared owner collision");
              }),
          }),
          Layer.mock(Runs.RunExecutionServiceV2)({}),
          Layer.mock(Policy.RuntimePolicyV2)({}),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const recovery = yield* Recovery.RemoteSessionRecovery;
      const parent = C.ThreadId.make("legacy-parent");
      for (const threadId of [parent, C.ThreadId.make("legacy-child")]) {
        const thread = yield* Schema.decodeUnknownEffect(C.OrchestrationV2AppThread)({
          id: threadId,
          projectId: C.ProjectId.make("project"),
          title: "Legacy",
          createdBy: "user",
          creationSource: "web",
          providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "test" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/workspace",
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: threadId === parent ? null : parent,
            relationshipToParent: threadId === parent ? null : "subagent",
            rootThreadId: parent,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          deletedAt: null,
        });
        const projection = {
          thread,
          runs: [],
          attempts: [],
          nodes: [],
          subagents: [],
          providerThreads: [],
          providerTurns: [],
          runtimeRequests: [],
          messages: [],
          turnItems: [],
          providerSessions: [
            {
              id: C.ProviderSessionId.make("provider-session:provider-instance:codex:shared"),
              driver: C.ProviderDriverKind.make("codex"),
              providerInstanceId: instanceId,
              status: "ready",
              cwd: "/workspace",
              model: "test",
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
          ],
        } satisfies Projections.ProjectionRuntimeRecoveryState;
        assert.isTrue(yield* recovery.isRemote(projection));
        assert.isFalse(yield* recovery.preserve(projection, "startup"));
        assert.isTrue(yield* recovery.preserve(projection, "shutdown"));
      }
      assert.equal(observations, 0);
      assert.equal(opens, 0);
    }).pipe(Effect.provide(layer));
  }),
);
