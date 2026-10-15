import { vi } from "vite-plus/test";
import {
  EnvironmentId,
  AuthSourceControlWriteScope,
  AuthOrchestrationOperateScope,
  ProjectId,
  PullRequestOperationError,
  WS_METHODS,
  type PullRequestStack,
  type AuthSessionState,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createLinkedPullRequestSummaryAtomFamily,
  createPullRequestEnvironmentAtoms,
  createPullRequestStackAtomFamily,
} from "./pullRequests.ts";
import * as PullRequestDiffLoader from "./pullRequestDiffHttp.ts";
import { executeAtomQuery } from "./runtime.ts";
import { GitHubRoutingPermissions } from "../connection/githubRoutingPermissions.ts";

const trustedRouting = {
  get: () => Effect.succeed("read-write" as const),
  changes: Stream.empty,
  set: () => Effect.void,
  forget: () => Effect.void,
};

class MutationRefused extends Data.TaggedError("MutationRefused") {}

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client: {
      ...client,
      [WS_METHODS.pullRequestsInvalidate]:
        client[WS_METHODS.pullRequestsInvalidate] ?? (() => Effect.void),
    },
    initialConfig: client[WS_METHODS.serverGetConfig]?.({}).pipe(Effect.orDie) ?? Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const makeTestRuntime = Effect.fn("makeTestRuntime")(function* (
  client: WsRpcProtocolClient,
  localClient?: WsRpcProtocolClient,
  localOrigin = false,
) {
  const originTarget = localOrigin
    ? new PrimaryConnectionTarget({
        ...TARGET,
        httpBaseUrl: "http://localhost:3774",
        wsBaseUrl: "ws://localhost:3774",
      })
    : TARGET;
  const connectionState: SupervisorConnectionState = {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    attempt: 1,
    generation: 1,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: originTarget,
    state: yield* SubscriptionRef.make(connectionState),
    session: yield* SubscriptionRef.make(Option.some(session(client))),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const localTarget = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("local-environment"),
    label: "Local environment",
    httpBaseUrl: "http://localhost:3773",
    wsBaseUrl: "ws://localhost:3773",
  });
  const localSupervisor = {
    ...supervisor,
    target: localTarget,
    session: yield* SubscriptionRef.make(Option.some(session(localClient ?? client))),
  };
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([
        [
          originTarget.environmentId,
          { target: originTarget, profile: Option.none(), enabled: true },
        ],
        ...(localClient === undefined
          ? []
          : [
              [
                localTarget.environmentId,
                { target: localTarget, profile: Option.none(), enabled: true },
              ] as const,
            ]),
      ]),
    ),
    run: (environmentId, effect) =>
      Effect.provideService(
        effect,
        EnvironmentSupervisor.EnvironmentSupervisor,
        environmentId === localTarget.environmentId ? localSupervisor : supervisor,
      ),
    runStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(GitHubRoutingPermissions, trustedRouting),
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      Layer.succeed(
        PullRequestDiffLoader.PullRequestDiffLoader,
        PullRequestDiffLoader.PullRequestDiffLoader.of({ load: () => Effect.die("unused") }),
      ),
    ),
  );
  const atoms = createPullRequestEnvironmentAtoms(runtime);
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return { runtime, atoms, registry, environmentRegistry, supervisor, localSupervisor };
});

it.effect("keeps concurrent diff file reads on different hosts separate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const release = yield* Latch.make();
      const started = yield* Latch.make();
      const calls: string[] = [];
      const client = {
        [WS_METHODS.pullRequestsDiffFileContents]: (input: { readonly host: string }) =>
          Effect.gen(function* () {
            calls.push(input.host);
            yield* started.open;
            yield* release.await;
            return { oldContents: "", newContents: input.host };
          }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const input = {
        projectId: ProjectId.make("project-1"),
        repository: "acme/web",
        number: 1,
        changeType: "change",
        oldPath: "src/app.ts",
        newPath: "src/app.ts",
      } as const;
      const first = atoms.diffFileContents.run(registry, {
        environmentId: TARGET.environmentId,
        input: { ...input, host: "github.com" },
      });
      yield* started.await;
      const second = atoms.diffFileContents.run(registry, {
        environmentId: TARGET.environmentId,
        input: { ...input, host: "github.example.com" },
      });
      yield* release.open;

      const results = yield* Effect.promise(() => Promise.all([first, second]));
      expect(results).toMatchObject([
        { _tag: "Success", value: { newContents: "github.com" } },
        { _tag: "Success", value: { newContents: "github.example.com" } },
      ]);
      expect(calls).toEqual(["github.com", "github.example.com"]);
    }),
  ),
);

it.effect("queues merge preparation with actions without restarting it on refresh", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const refreshEvents = yield* PubSub.unbounded<number>();
      const calls: string[] = [];
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.fromPubSub(refreshEvents),
        [WS_METHODS.pullRequestsDetail]: (input: { number: number; allowStale?: boolean }) =>
          Effect.gen(function* () {
            expect(input.allowStale).toBe(false);
            calls.push(`detail:${input.number}`);
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return {
              state: "open",
              isDraft: false,
              capabilities: { actions: ["merge"], stackActions: true },
              viewerPermissions: { actions: ["merge"] },
            };
          }),
        [WS_METHODS.pullRequestsStack]: (input: { number: number; allowStale?: boolean }) =>
          Effect.sync(() => {
            expect(input.allowStale).toBe(false);
            calls.push(`stack:${input.number}`);
            return null;
          }),
        [WS_METHODS.pullRequestsRunAction]: (input: {
          action: string;
          number: number;
          mergeMethod?: string;
        }) =>
          Effect.sync(() => {
            if (input.action === "merge") expect(input.mergeMethod).toBe("squash");
            expect(input).not.toHaveProperty("resolveMergeMethod");
            calls.push(`${input.action}:${input.number}`);
          }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const unmount = registry.mount(
        atoms.refreshes({ environmentId: TARGET.environmentId, input: {} }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      const reference = { projectId: ProjectId.make("project-1"), repository: "acme/web" };
      const first = atoms.runAction.run(registry, {
        environmentId: TARGET.environmentId,
        input: { ...reference, number: 1, action: "merge", resolveMergeMethod: () => "squash" },
      });
      yield* Deferred.await(started);
      const second = atoms.runAction.run(registry, {
        environmentId: TARGET.environmentId,
        input: { ...reference, number: 2, action: "close" },
      });
      yield* PubSub.publish(refreshEvents, 1);
      expect(calls).toEqual(["detail:1"]);
      yield* Deferred.succeed(release, undefined);
      const results = yield* Effect.promise(() => Promise.all([first, second]));
      expect(results.every(AsyncResult.isSuccess)).toBe(true);
      expect(calls).toEqual(["detail:1", "stack:1", "merge:1", "close:2"]);
    }),
  ),
);

it.effect.each(["closed", "draft", "permission", "stack", "method"] as const)(
  "rejects an unsafe quick merge with %s and keeps later actions running",
  (reason) =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const client = {
          [WS_METHODS.pullRequestsDetail]: () =>
            Effect.succeed({
              state: reason === "closed" ? "closed" : "open",
              isDraft: reason === "draft",
              capabilities: { actions: ["merge"], stackActions: true },
              viewerPermissions: { actions: reason === "permission" ? [] : ["merge"] },
            }),
          [WS_METHODS.pullRequestsStack]: () => Effect.succeed(reason === "stack" ? {} : null),
          [WS_METHODS.pullRequestsRunAction]: (input: { action: string }) =>
            Effect.sync(() => calls.push(input.action)),
        } as unknown as WsRpcProtocolClient;
        const { atoms, registry } = yield* makeTestRuntime(client);
        const target = {
          environmentId: TARGET.environmentId,
          input: { projectId: ProjectId.make("project-1"), repository: "acme/web", number: 1 },
        };
        const merge = atoms.runAction.run(registry, {
          ...target,
          input: {
            ...target.input,
            action: "merge",
            resolveMergeMethod: () => {
              if (reason === "method") throw new Error("No merge method is available.");
              return "squash";
            },
          },
        });
        const close = atoms.runAction.run(registry, {
          ...target,
          input: { ...target.input, action: "close" },
        });
        const results = yield* Effect.promise(() => Promise.all([merge, close]));
        expect(results.map((result) => result._tag)).toEqual(["Failure", "Success"]);
        expect(calls).toEqual(["close"]);
      }),
    ),
);

it.effect("keeps a close batch ordered and continues after a refused close", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: number[] = [];
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const client = {
        [WS_METHODS.pullRequestsRunAction]: (input: { number: number; action: string }) =>
          Effect.gen(function* () {
            expect(input.action).toBe("close");
            calls.push(input.number);
            if (input.number === 6) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
            }
            if (input.number === 5)
              return yield* new PullRequestOperationError({
                operation: "runAction",
                detail: "You cannot close this pull request.",
              });
          }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const batch = [6, 5, 4].map((number) =>
        atoms.runAction.run(registry, {
          environmentId: TARGET.environmentId,
          input: {
            projectId: ProjectId.make("project-1"),
            repository: "acme/web",
            number,
            action: "close",
          },
        }),
      );
      yield* Deferred.await(started);
      expect(calls).toEqual([6]);
      yield* Deferred.succeed(release, undefined);
      const results = yield* Effect.promise(() => Promise.all(batch));
      expect(results.map((result) => result._tag)).toEqual(["Success", "Failure", "Success"]);
      expect(calls).toEqual([6, 5, 4]);
    }),
  ),
);

it.effect("keeps hover previews fresh after edits and turns", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const refreshEvents = yield* PubSub.unbounded<number>();
      let title = "Original title";
      let reads = 0;
      const read = (input: unknown) =>
        Effect.sync(() => {
          expect(input).toEqual(reference);
          reads++;
          return { ...reference, title };
        });
      const reference = {
        projectId: ProjectId.make("project-1"),
        repository: "acme/web",
        number: 1,
        host: "github.example.com",
      };
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.fromPubSub(refreshEvents),
        [WS_METHODS.pullRequestsPreview]: read,
        [WS_METHODS.pullRequestsDetail]: read,
        [WS_METHODS.pullRequestsUpdate]: (input: { title: string }) =>
          Effect.sync(() => {
            title = input.title;
          }),
        [WS_METHODS.pullRequestsRunAction]: () =>
          Effect.sync(() => {
            title = "Closed";
          }),
        [WS_METHODS.pullRequestsInvalidate]: () => Effect.void,
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = { environmentId: TARGET.environmentId, input: reference };
      const preview = atoms.preview(target);
      const unmount = registry.mount(preview);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      expect(
        (yield* AtomRegistry.getResult(registry, preview, { suspendOnWaiting: true })).title,
      ).toBe(title);
      yield* Effect.promise(() => executeAtomQuery(registry, preview));
      expect(reads).toBe(1);
      const edited = yield* Effect.promise(() =>
        atoms.update.run(registry, { ...target, input: { ...reference, title: "Edited" } }),
      );
      expect(AsyncResult.isSuccess(edited)).toBe(true);
      expect(
        (yield* AtomRegistry.getResult(registry, preview, { suspendOnWaiting: true })).title,
      ).toBe("Edited");
      yield* Effect.promise(() =>
        atoms.runAction.run(registry, { ...target, input: { ...reference, action: "close" } }),
      );
      expect(
        (yield* AtomRegistry.getResult(registry, preview, { suspendOnWaiting: true })).title,
      ).toBe("Closed");
      title = "Refreshed";
      yield* Effect.promise(() =>
        atoms.invalidate.run(registry, {
          environmentId: target.environmentId,
          input: { reference },
        }),
      );
      expect(
        (yield* AtomRegistry.getResult(registry, preview, { suspendOnWaiting: true })).title,
      ).toBe("Refreshed");
      const refreshed = Latch.makeUnsafe();
      const stop = registry.subscribe(preview, (result) => {
        if (AsyncResult.isSuccess(result) && result.value.title === "After turn")
          refreshed.openUnsafe();
      });
      yield* Effect.addFinalizer(() => Effect.sync(stop));
      title = "After turn";
      yield* PubSub.publish(refreshEvents, 1);
      yield* refreshed.await;
    }),
  ),
);

it.effect("shares close, reopen, and merge with an untouched client's mounted PR readers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const revision = yield* SubscriptionRef.make(0);
      let state: "open" | "closed" | "merged" = "open";
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => SubscriptionRef.changes(revision),
        [WS_METHODS.pullRequestsSummary]: () => Effect.sync(() => ({ state })),
        [WS_METHODS.pullRequestsDetail]: () => Effect.sync(() => ({ state })),
        [WS_METHODS.pullRequestsList]: () =>
          Effect.sync(() => ({ entries: [{ number: 1, state }] })),
        [WS_METHODS.pullRequestsRunAction]: (input: {
          readonly action: "close" | "reopen" | "merge";
        }) =>
          Effect.gen(function* () {
            state =
              input.action === "close" ? "closed" : input.action === "merge" ? "merged" : "open";
            yield* SubscriptionRef.update(revision, (value) => value + 1);
          }),
      } as unknown as WsRpcProtocolClient;
      const writer = yield* makeTestRuntime(client);
      const reader = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: {
          projectId: ProjectId.make("project-1"),
          host: "github.example.com",
          repository: "acme/web",
          number: 1,
        },
      };
      const detail = reader.atoms.detail(target);
      const summary = createLinkedPullRequestSummaryAtomFamily(
        reader.runtime,
        reader.atoms.refreshes,
      )(target);
      const list = reader.atoms.list({
        environmentId: TARGET.environmentId,
        input: { state: "all" },
      });
      const unmountDetail = reader.registry.mount(detail);
      const unmountSummary = reader.registry.mount(summary);
      const unmountList = reader.registry.mount(list);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unmountDetail();
          unmountSummary();
          unmountList();
        }),
      );
      expect((yield* AtomRegistry.getResult(reader.registry, detail)).state).toBe("open");
      expect((yield* AtomRegistry.getResult(reader.registry, summary)).state).toBe("open");
      expect((yield* AtomRegistry.getResult(reader.registry, list)).entries[0]?.state).toBe("open");

      for (const [action, expected] of [
        ["close", "closed"],
        ["reopen", "open"],
        ["merge", "merged"],
      ] as const) {
        const detailChanged = Latch.makeUnsafe();
        const summaryChanged = Latch.makeUnsafe();
        const listChanged = Latch.makeUnsafe();
        const stops = [
          reader.registry.subscribe(detail, (result) => {
            if (AsyncResult.isSuccess(result) && result.value.state === expected) {
              detailChanged.openUnsafe();
            }
          }),
          reader.registry.subscribe(summary, (result) => {
            if (AsyncResult.isSuccess(result) && result.value.state === expected) {
              summaryChanged.openUnsafe();
            }
          }),
          reader.registry.subscribe(list, (result) => {
            if (AsyncResult.isSuccess(result) && result.value.entries[0]?.state === expected) {
              listChanged.openUnsafe();
            }
          }),
        ];
        yield* Effect.addFinalizer(() => Effect.sync(() => stops.forEach((stop) => stop())));
        const result = yield* Effect.promise(() =>
          writer.atoms.runAction.run(writer.registry, {
            ...target,
            input: { ...target.input, action },
          }),
        );
        expect(AsyncResult.isSuccess(result)).toBe(true);
        // The second client receives only the server push: no local refresh or timer tick.
        yield* detailChanged.await;
        yield* summaryChanged.await;
        yield* listChanged.await;
        expect((yield* AtomRegistry.getResult(reader.registry, detail)).state).toBe(expected);
        expect((yield* AtomRegistry.getResult(reader.registry, summary)).state).toBe(expected);
        expect((yield* AtomRegistry.getResult(reader.registry, list)).entries[0]?.state).toBe(
          expected,
        );
        stops.forEach((stop) => stop());
      }
    }),
  ),
);

it.effect("refreshes pull request activity after a comment is updated", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const refreshEvents = yield* PubSub.unbounded<number>();
      let commentBody = "old comment";
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.fromPubSub(refreshEvents),
        [WS_METHODS.pullRequestsActivity]: () =>
          Effect.succeed({
            author: null,
            reviewers: [],
            comments: [
              {
                id: "comment-1",
                kind: "issue-comment",
                author: null,
                body: commentBody,
                createdAt: "2026-08-24T00:00:00Z",
                url: null,
                path: null,
                reviewState: null,
                reactions: [],
              },
            ],
            commentCount: 1,
            commentsTruncated: false,
            reviewThreads: [],
            commits: [],
            reactions: [],
          }),
        [WS_METHODS.pullRequestsUpdateComment]: (input: { readonly body: string }) =>
          Effect.sync(() => {
            commentBody = input.body;
          }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const reference = {
        projectId: ProjectId.make("project-1"),
        host: "github.example.com",
        repository: "acme/web",
        number: 1,
      } as const;
      const activity = atoms.activity({ environmentId: TARGET.environmentId, input: reference });
      const unmount = registry.mount(activity);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));

      const initial = yield* Effect.promise(() => executeAtomQuery(registry, activity));
      expect(AsyncResult.isSuccess(initial)).toBe(true);
      if (!AsyncResult.isSuccess(initial)) {
        return yield* Effect.die("activity did not load");
      }
      expect(initial.value.comments[0]?.body).toBe("old comment");

      const update = yield* Effect.promise(() =>
        atoms.updateComment.run(registry, {
          environmentId: TARGET.environmentId,
          input: { ...reference, commentId: "comment-1", kind: "issue-comment", body: "updated" },
        }),
      );

      expect(AsyncResult.isSuccess(update)).toBe(true);
      expect(
        (yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true })).comments[0]
          ?.body,
      ).toBe("updated");
      const refreshed = Latch.makeUnsafe();
      const stop = registry.subscribe(activity, (result) => {
        if (AsyncResult.isSuccess(result) && result.value.comments[0]?.body === "after turn") {
          refreshed.openUnsafe();
        }
      });
      yield* Effect.addFinalizer(() => Effect.sync(stop));

      commentBody = "after turn";
      yield* PubSub.publish(refreshEvents, 1);
      yield* refreshed.await;

      expect(
        (yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true })).comments[0]
          ?.body,
      ).toBe("after turn");
    }),
  ),
);

it.effect("refreshes checks without refreshing full detail", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let detailReads = 0;
      let checksReads = 0;
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsDetail]: () =>
          Effect.sync(() => {
            detailReads++;
            return { title: "PR" };
          }),
        [WS_METHODS.pullRequestsChecks]: () =>
          Effect.sync(() => {
            checksReads++;
            return { state: checksReads === 1 ? "open" : "merged", checks: [] };
          }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: { projectId: ProjectId.make("project-1"), repository: "acme/web", number: 1 },
      };
      const detail = atoms.detail(target);
      const checks = atoms.checks(target);
      yield* AtomRegistry.mount(registry, detail);
      yield* AtomRegistry.mount(registry, checks);
      yield* AtomRegistry.getResult(registry, detail);
      expect((yield* AtomRegistry.getResult(registry, checks))?.state).toBe("open");
      registry.refresh(checks);
      expect(
        (yield* AtomRegistry.getResult(registry, checks, { suspendOnWaiting: true }))?.state,
      ).toBe("merged");
      expect(detailReads).toBe(1);
      expect(checksReads).toBe(2);
    }),
  ),
);

it.effect("keeps live detail reads separate from reads that allow stale data", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsDetail]: (input: { allowStale?: boolean }) =>
          Effect.succeed({ title: input.allowStale === false ? "latest checks" : "cached checks" }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: { projectId: ProjectId.make("project-1"), repository: "acme/web", number: 1 },
      };
      const cached = atoms.detail(target);
      const live = atoms.detail({ ...target, input: { ...target.input, allowStale: false } });
      expect((yield* AtomRegistry.getResult(registry, cached)).title).toBe("cached checks");
      expect((yield* AtomRegistry.getResult(registry, live)).title).toBe("latest checks");
    }),
  ),
);

it.effect("updates cached labels after successful edits without rereading the host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let detailReads = 0;
      let candidateReads = 0;
      let refuse = false;
      let failDetail = false;
      const existing = { name: "existing", color: "111111" };
      const addedLabel = { name: "new", color: "abcdef" };
      const detailRefreshStarted = yield* Latch.make();
      const releaseDetailRefresh = yield* Latch.make();
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsDetail]: () =>
          Effect.gen(function* () {
            detailReads++;
            if (failDetail) {
              yield* detailRefreshStarted.open;
              yield* releaseDetailRefresh.await;
              return yield* new MutationRefused();
            }
            return { title: "keep this title", labels: [existing] };
          }),
        [WS_METHODS.pullRequestsLabelCandidates]: () =>
          Effect.sync(() => {
            candidateReads++;
            return {
              candidates: [
                { ...existing, description: null, isApplied: true },
                { ...addedLabel, description: "description", isApplied: false },
              ],
              truncated: false,
            };
          }),
        [WS_METHODS.pullRequestsSetLabels]: () =>
          refuse ? Effect.fail(new MutationRefused()) : Effect.void,
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: {
          projectId: ProjectId.make("project-1"),
          repository: "acme/web",
          number: 1,
          host: "github.example.com",
        },
      };
      const detail = atoms.detail(target);
      const candidates = atoms.labelCandidates(target);
      registry.mount(detail);
      const unmountCandidates = registry.mount(candidates);
      yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });
      yield* AtomRegistry.getResult(registry, candidates, { suspendOnWaiting: true });

      const added = yield* Effect.promise(() =>
        atoms.setLabels.run(registry, {
          ...target,
          input: {
            host: target.input.host,
            projectId: target.input.projectId,
            repository: target.input.repository,
            number: target.input.number,
            labels: ["new"],
            applied: true,
          },
        }),
      );
      expect(AsyncResult.isSuccess(added)).toBe(true);
      expect(yield* AtomRegistry.getResult(registry, detail)).toEqual({
        title: "keep this title",
        labels: [existing, addedLabel],
      });
      unmountCandidates();
      registry.mount(atoms.labelCandidates(target));
      expect((yield* AtomRegistry.getResult(registry, candidates)).candidates[1]).toEqual({
        ...addedLabel,
        description: "description",
        isApplied: true,
      });

      for (const name of ["existing", "new"]) {
        refuse = name === "new";
        const result = yield* Effect.promise(() =>
          atoms.setLabels.run(registry, {
            ...target,
            input: { ...target.input, labels: [name], applied: false },
          }),
        );
        expect(result._tag).toBe(refuse ? "Failure" : "Success");
        expect((yield* AtomRegistry.getResult(registry, detail)).labels).toEqual([addedLabel]);
        expect((yield* AtomRegistry.getResult(registry, candidates)).candidates).toMatchObject([
          { name: "existing", isApplied: false },
          { name: "new", isApplied: true },
        ]);
      }
      expect(detailReads).toBe(1);
      expect(candidateReads).toBe(1);

      failDetail = true;
      registry.refresh(detail);
      yield* detailRefreshStarted.await;
      expect(registry.get(detail).waiting).toBe(true);
      expect(Option.getOrThrow(AsyncResult.value(registry.get(detail))).labels).toEqual([
        addedLabel,
      ]);
      yield* releaseDetailRefresh.open;
      yield* Effect.exit(AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true }));
      expect(AsyncResult.isFailure(registry.get(detail))).toBe(true);
      expect(Option.getOrThrow(AsyncResult.value(registry.get(detail))).labels).toEqual([
        addedLabel,
      ]);
      failDetail = false;
      registry.refresh(detail);
      expect(
        (yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true })).labels,
      ).toEqual([existing]);
      expect(detailReads).toBe(3);
    }),
  ),
);

it.effect("updates reviewer requests and enriched reviewers without rereading the host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let reads = 0;
      let refuse = false;
      const actor = { login: "reviewer", name: "Reviewer", avatarUrl: null };
      const hostActor = { ...actor, login: "Reviewer" };
      let hostRequested = false;
      let reviewed = false;
      let pauseActivity = false;
      const activityStarted = yield* Latch.make();
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsDetail]: () =>
          Effect.sync(() => {
            reads++;
            return { reviewers: hostRequested ? [hostActor] : [] };
          }),
        [WS_METHODS.pullRequestsActivity]: () =>
          Effect.gen(function* () {
            reads++;
            if (pauseActivity) {
              pauseActivity = false;
              yield* activityStarted.open;
              return yield* Effect.never;
            }
            return {
              reviewers: hostRequested ? [hostActor] : [],
              comments: reviewed ? [{ kind: "review-comment", author: hostActor }] : [],
            };
          }),
        [WS_METHODS.pullRequestsReviewerCandidates]: (input: { number: number }) =>
          input.number === 2
            ? Effect.never
            : Effect.sync(() => {
                reads++;
                return {
                  candidates: [{ ...actor, id: "12", kind: "user", isRequested: false }],
                  truncated: false,
                };
              }),
        [WS_METHODS.pullRequestsRequestReviewers]: (input: { requested: boolean }) =>
          refuse
            ? Effect.fail(new MutationRefused())
            : Effect.sync(() => {
                hostRequested = input.requested;
              }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: {
          projectId: ProjectId.make("project-1"),
          repository: "acme/web",
          number: 1,
          host: "github.example.com",
        },
      };
      const detail = atoms.detail(target);
      const activity = atoms.activity(target);
      const candidates = atoms.reviewerCandidates(target);
      registry.mount(detail);
      registry.mount(activity);
      registry.mount(candidates);
      yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });
      yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true });
      yield* AtomRegistry.getResult(registry, candidates, { suspendOnWaiting: true });
      const request = (requested: boolean, reference = target) =>
        Effect.promise(() =>
          atoms.requestReviewers.run(registry, {
            ...reference,
            input: { ...reference.input, reviewers: [{ id: "12", kind: "user" }], requested },
          }),
        );
      for (const operation of ["request", "refuse", "remove"]) {
        refuse = operation === "refuse";
        expect((yield* request(operation === "request"))._tag).toBe(refuse ? "Failure" : "Success");
        const expected = operation === "remove" ? [] : [actor];
        expect((yield* AtomRegistry.getResult(registry, detail)).reviewers).toEqual(expected);
        expect((yield* AtomRegistry.getResult(registry, activity)).reviewers).toEqual(expected);
        expect((yield* AtomRegistry.getResult(registry, candidates)).candidates).toMatchObject([
          { isRequested: operation !== "remove" },
        ]);
      }
      expect(reads).toBe(3);
      // A slow activity read started before the write must not hide the new request.
      pauseActivity = true;
      registry.refresh(activity);
      yield* activityStarted.await;
      expect(AsyncResult.isSuccess(yield* request(true))).toBe(true);
      expect(
        (yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true })).reviewers,
      ).toEqual([hostActor]);
      expect(reads).toBe(5);
      expect(AsyncResult.isSuccess(yield* request(false))).toBe(true);
      expect((yield* AtomRegistry.getResult(registry, activity)).reviewers).toEqual([]);

      reviewed = true;
      yield* request(true);
      registry.refresh(activity);
      yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true });
      yield* request(false);
      expect((yield* AtomRegistry.getResult(registry, activity)).reviewers).toEqual([hostActor]);

      // A caller without an open picker still needs authoritative reviewer identities.
      const otherTarget = { ...target, input: { ...target.input, number: 2 } };
      const otherDetail = atoms.detail(otherTarget);
      registry.mount(otherDetail);
      yield* AtomRegistry.getResult(registry, otherDetail, { suspendOnWaiting: true });
      yield* request(true, otherTarget);
      expect(
        (yield* AtomRegistry.getResult(registry, otherDetail, { suspendOnWaiting: true }))
          .reviewers,
      ).toEqual([hostActor]);
    }),
  ),
);

it.effect("refreshes stack state after reopening and head SHAs after a turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const refreshEvents = yield* PubSub.unbounded<number>();
      let state: "closed" | "open" = "closed";
      let headSha = "old-head";
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.fromPubSub(refreshEvents),
        [WS_METHODS.pullRequestsStack]: () =>
          Effect.sync(
            () =>
              ({
                id: "stack-1",
                number: 1,
                url: "https://github.com/acme/web/pull/1",
                base: "main",
                layers: [
                  {
                    number: 1,
                    headBranch: "feature",
                    headSha,
                    state,
                    isDraft: false,
                  },
                ],
              }) satisfies PullRequestStack,
          ),
      } as unknown as WsRpcProtocolClient;
      const { runtime, registry } = yield* makeTestRuntime(client);
      const stacks = createPullRequestStackAtomFamily(runtime);
      const stack = stacks({
        environmentId: TARGET.environmentId,
        input: {
          projectId: ProjectId.make("project-1"),
          repository: "acme/web",
          number: 1,
        },
      });
      const unmount = registry.mount(stack);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      yield* Effect.promise(() => executeAtomQuery(registry, stack));
      expect((yield* AtomRegistry.getResult(registry, stack))?.layers[0]?.state).toBe("closed");
      state = "open";
      registry.refresh(stack);
      expect(
        (yield* AtomRegistry.getResult(registry, stack, { suspendOnWaiting: true }))?.layers[0]
          ?.state,
      ).toBe("open");

      const refreshed = Latch.makeUnsafe();
      const stop = registry.subscribe(stack, (result) => {
        if (AsyncResult.isSuccess(result) && result.value?.layers[0]?.headSha === "new-head") {
          refreshed.openUnsafe();
        }
      });
      yield* Effect.addFinalizer(() => Effect.sync(stop));
      headSha = "new-head";
      yield* PubSub.publish(refreshEvents, 1);
      yield* refreshed.await;
      expect((yield* AtomRegistry.getResult(registry, stack))?.layers[0]?.headSha).toBe("new-head");
    }),
  ),
);

// Transport fixtures have a source-control-only session; authorization edge cases
// are exercised by commandPermissions.test.ts.
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: grantedSessions }),
}));
const grantedSessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthSourceControlWriteScope],
    }),
  ),
);

it.effect("publishes the accepted guide run before the follow-up read finishes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const accepted = {
        guide: null,
        currentHeadSha: "head",
        run: { _tag: "Running" as const, headSha: "head", startedAt: "2026-10-11T00:00:00.000Z" },
      };
      let reads = 0;
      const refreshStarted = yield* Latch.make();
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsReviewGuide]: () =>
          Effect.gen(function* () {
            if (++reads > 1) {
              yield* refreshStarted.open;
              return yield* Effect.never;
            }
            return { guide: null, run: null, currentHeadSha: "head" };
          }),
        [WS_METHODS.pullRequestsGenerateReviewGuide]: () => Effect.succeed(accepted),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: { projectId: ProjectId.make("project-1"), repository: "acme/web", number: 1 },
      };
      registry.update(
        grantedSessions(target.environmentId),
        AsyncResult.map((session) => ({
          ...session,
          scopes: [...(session.scopes ?? []), AuthOrchestrationOperateScope],
        })),
      );
      const query = atoms.reviewGuide(target);
      registry.mount(query);
      yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
      const result = yield* Effect.promise(() => atoms.generateReviewGuide.run(registry, target));
      expect(result._tag).toBe("Success");
      yield* refreshStarted.await;
      expect(Option.getOrNull(AsyncResult.value(registry.get(query)))).toEqual(accepted);
    }),
  ),
);

for (const operation of ["read", "write"] as const) {
  it.effect.each([false, true])(
    `keeps PR ${operation}s on their owning environment when it fails: %s`,
    (fails) =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: string[] = [];
          const reference = {
            projectId: ProjectId.make("project-1"),
            host: "github.example.com",
            repository: "acme/web",
            number: 1,
            allowStale: false,
          };
          const failure = new PullRequestOperationError({
            operation: "request",
            detail: "The owning environment could not complete the request.",
          });
          const clientFor = (name: string) =>
            ({
              [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
              [WS_METHODS.pullRequestsRouting]: () =>
                Effect.succeed({
                  host: reference.host,
                  provider: "github",
                  viewer: "viewer",
                  accountId: "123",
                }),
              [WS_METHODS.pullRequestsRoutingIdentity]: () =>
                Effect.succeed({
                  host: reference.host,
                  provider: "github",
                  viewer: "viewer",
                  accountId: "123",
                }),
              [WS_METHODS.pullRequestsSummary]: (input: unknown) =>
                Effect.gen(function* () {
                  calls.push(`${name}:read`);
                  expect(input).toEqual(reference);
                  if (fails) return yield* failure;
                  return null;
                }),
              [WS_METHODS.pullRequestsRunAction]: (input: unknown) =>
                Effect.gen(function* () {
                  calls.push(`${name}:write`);
                  expect(input).toEqual({ ...reference, action: "close" });
                  if (fails) return yield* failure;
                }),
            }) as unknown as WsRpcProtocolClient;
          const { runtime, atoms, registry } = yield* makeTestRuntime(
            clientFor("origin"),
            clientFor("alternate"),
          );
          const target = { environmentId: TARGET.environmentId, input: reference };
          if (operation === "read") {
            const summary = createLinkedPullRequestSummaryAtomFamily(runtime)(target);
            const result = yield* AtomRegistry.getResult(registry, summary).pipe(Effect.exit);
            expect(result._tag).toBe(fails ? "Failure" : "Success");
          } else {
            const result = yield* Effect.promise(() =>
              atoms.runAction.run(registry, {
                ...target,
                input: { ...reference, action: "close" },
              }),
            );
            expect(result._tag).toBe(fails ? "Failure" : "Success");
          }
          expect(calls).toEqual([`origin:${operation}`]);
        }),
      ),
  );
}

it.effect("denies a PR action when its owning environment has no write permission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let writes = 0;
      const client = {
        [WS_METHODS.pullRequestsRunAction]: () => Effect.sync(() => writes++),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client, client);
      yield* AtomRegistry.mount(registry, grantedSessions(TARGET.environmentId));
      registry.set(
        grantedSessions(TARGET.environmentId),
        AsyncResult.success({
          authenticated: true,
          scopes: [],
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: [],
            sessionMethods: [],
            sessionCookieName: "test",
          },
        }),
      );
      const result = yield* Effect.promise(() =>
        atoms.runAction.run(registry, {
          environmentId: TARGET.environmentId,
          input: {
            projectId: ProjectId.make("project-1"),
            repository: "acme/web",
            number: 1,
            action: "close",
          },
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(writes).toBe(0);
    }),
  ),
);

it.effect("invalidates PR caches only on the owning environment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: { environment: string; input: unknown }[] = [];
      const clientFor = (environment: string) =>
        ({
          [WS_METHODS.pullRequestsInvalidate]: (input: unknown) =>
            Effect.sync(() => {
              calls.push({ environment, input });
            }),
        }) as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(
        clientFor("origin"),
        clientFor("alternate"),
      );
      const reference = {
        projectId: ProjectId.make("project-1"),
        host: "github.example.com",
        repository: "acme/web",
        number: 1,
      };
      for (const input of [{ reference }, { reference, filesViewedOnly: true }, {}]) {
        const result = yield* Effect.promise(() =>
          atoms.invalidate.run(registry, { environmentId: TARGET.environmentId, input }),
        );
        expect(result._tag).toBe("Success");
      }
      expect(calls).toEqual([
        { environment: "origin", input: { reference } },
        { environment: "origin", input: { reference, filesViewedOnly: true } },
        { environment: "origin", input: {} },
      ]);
    }),
  ),
);
