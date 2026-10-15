import * as Enrollment from "./LifecycleEnrollment.ts";
import * as UsageHistory from "./UsageHistory.ts";
import { WorkspaceActivity, WorkspaceRecentActivity } from "./WorkspaceActivity.ts";
import {
  ThreadId,
  TerminalSummary,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import {
  projectScriptRuntimeEnv,
  resolveProjectScripts,
  settleProjectScript,
} from "@t3tools/shared/projectScripts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";
import type { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import { sameIdentity } from "../execution/ExecutionWorker.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RuntimeClient from "./RuntimeClient.ts";
import * as Protocol from "./worker/Protocol.ts";

export class LifecyclePolicyError extends Schema.TaggedError<LifecyclePolicyError>()(
  "LifecyclePolicyError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type LifecycleMember = {
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "id"
    | "activeRunId"
    | "activityRunStatus"
    | "status"
    | "pendingBackgroundTasks"
    | "createdAt"
    | "latestUserMessageAt"
    | "latestRunCompletedAt"
    | "settledAt"
    | "settledOverride"
  >;
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "queueHeld">>;
  requests: ReadonlyArray<Pick<OrchestrationV2RuntimeRequest, "status" | "responseCapability">>;
  subagents: ReadonlyArray<Pick<OrchestrationV2Subagent, "status">>;
  nativeBackground: boolean;
  unassignedUserMessages: boolean;
};
export type LifecycleSnapshot = {
  ownerThreadId: ThreadId;
  workspaceId: string;
  revision: number;
  kind: "thread" | "utility";
  members: ReadonlyArray<LifecycleMember>;
  pendingEffects: boolean;
  settlementProven?: boolean;
  settleScript: Omit<typeof Protocol.Script.Type, "operationId"> | null;
};
export type LifecycleDecision =
  | "stopped"
  | "busy"
  | "grace"
  | "stale"
  | "script-running"
  | "suspend-submitted"
  | "release-submitted";

function memberIsBusy(member: LifecycleMember): boolean {
  const thread = member.thread;
  if (thread.activeRunId !== null || thread.activityRunStatus != null) return true;
  if (["preparing", "starting", "running", "waiting"].includes(thread.status)) return true;
  if (
    (thread.pendingBackgroundTasks ?? []).length > 0 ||
    member.nativeBackground ||
    member.unassignedUserMessages
  )
    return true;
  if (
    member.runs.some((run) =>
      run.status === "queued"
        ? run.queueHeld !== true
        : ["preparing", "starting", "running", "waiting"].includes(run.status),
    )
  )
    return true;
  if (
    member.requests.some(
      (request) => request.status === "pending" && request.responseCapability.type !== "message",
    )
  )
    return true;
  return member.subagents.some((task) => ["pending", "running", "waiting"].includes(task.status));
}

const millis = (value: DateTime.Utc | null | undefined): number =>
  value ? DateTime.toEpochMillis(value) : 0;
function lastActivity(snapshot: LifecycleSnapshot): number {
  return Math.max(
    0,
    ...snapshot.members.flatMap(({ thread }) => [
      millis(thread.createdAt),
      millis(thread.latestUserMessageAt),
      millis(thread.latestRunCompletedAt),
      millis(thread.settledAt),
    ]),
  );
}
const owner = (snapshot: LifecycleSnapshot) =>
  snapshot.members.find((member) => member.thread.id === snapshot.ownerThreadId)?.thread;
const settlementAt = (snapshot: LifecycleSnapshot) => {
  const thread = owner(snapshot);
  return thread?.settledOverride === "settled" && thread.settledAt
    ? millis(thread.settledAt)
    : null;
};
const decodeScriptResult = Schema.decodeUnknownEffect(Protocol.ScriptResult);
const decodeStopReceipt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RuntimeClient.LifecycleStopRequest),
);
const failure = (operation: string) => (cause: unknown) =>
  new LifecyclePolicyError({ operation, cause });

export interface LifecyclePolicyPorts {
  readonly enabled: boolean;
  readonly idleMs: number;
  readonly roots: Effect.Effect<ReadonlyArray<ThreadId>, LifecyclePolicyError>;
  readonly recoverSettlements: Effect.Effect<void, LifecyclePolicyError>;
  readonly enroll: (threadId: ThreadId) => Effect.Effect<void, LifecyclePolicyError>;
  readonly retire: (
    snapshot: LifecycleSnapshot,
    completed: RuntimeClient.CompletedStop,
  ) => Effect.Effect<void, LifecyclePolicyError>;
  readonly read: (
    threadId: ThreadId,
  ) => Effect.Effect<LifecycleSnapshot | null, LifecyclePolicyError>;
  readonly observe: (
    workspaceId: string,
  ) => Effect.Effect<RuntimeClient.RuntimeObservation, LifecyclePolicyError>;
  readonly resume: (workspaceId: string) => Effect.Effect<ExecutionClient, LifecyclePolicyError>;
  readonly collectUsage: (
    client: ExecutionClient,
    force: boolean,
  ) => Effect.Effect<void, LifecyclePolicyError>;
  readonly stop: (
    snapshot: LifecycleSnapshot,
    action: "suspend" | "release_compute",
    operationId: string,
    identity: ExecutionIdentity,
  ) => Effect.Effect<void, LifecyclePolicyError>;
}

export class LifecyclePolicy extends Context.Service<
  LifecyclePolicy,
  {
    readonly enabled: boolean;
    readonly reconcileThread: (
      threadId: ThreadId,
    ) => Effect.Effect<LifecycleDecision, LifecyclePolicyError>;
    readonly requestSettlement: (threadId: ThreadId) => Effect.Effect<void>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/agentRuntime/LifecyclePolicy") {}

export const makePolicy = Effect.fn("LifecyclePolicy.makePolicy")(function* (
  ports: LifecyclePolicyPorts,
) {
  const scope = yield* Scope.Scope;
  const activity = yield* WorkspaceActivity;
  const recentActivity = yield* WorkspaceRecentActivity;
  const activityGuard = (snapshot: LifecycleSnapshot) =>
    Effect.gen(function* () {
      const { workspaceId } = snapshot;
      if (activity.has(workspaceId)) return "busy" as const;
      const recent = recentActivity.get(workspaceId);
      if (recent !== undefined) {
        const settledAt = settlementAt(snapshot);
        if (settledAt !== null && recent <= settledAt) return null;
        const now = yield* Clock.currentTimeMillis;
        if (now - recent < ports.idleMs) return "grace" as const;
        recentActivity.delete(workspaceId);
      }
      return null;
    });
  const inProgress = new Set<string>();
  const usageAttempts = new Map<string, { revision: number; at: number }>();
  const utilities = new Map<string, { incarnation: string; since: number }>();
  const invoke = (client: ExecutionClient, method: string, input: unknown, operationId?: string) =>
    Effect.tryPromise({
      try: () => client.call(method, input, operationId),
      catch: failure(method),
    });
  const reconcileThread = Effect.fn("LifecyclePolicy.reconcileThread")(function* (
    threadId: ThreadId,
  ) {
    if (!ports.enabled) return "stopped" as const;
    let snapshot = yield* ports.read(threadId);
    if (!snapshot || snapshot.ownerThreadId !== threadId) return "busy" as const;
    const nowBeforeObservation = yield* Clock.currentTimeMillis;
    const guard = yield* activityGuard(snapshot);
    const activityAtBeforeObservation =
      snapshot.kind === "utility"
        ? utilities.get(snapshot.workspaceId)?.since
        : lastActivity(snapshot);
    const deferredDecision =
      guard ??
      (snapshot.pendingEffects || snapshot.members.some(memberIsBusy)
        ? ("busy" as const)
        : settlementAt(snapshot) === null &&
            activityAtBeforeObservation !== undefined &&
            nowBeforeObservation - activityAtBeforeObservation < ports.idleMs
          ? ("grace" as const)
          : null);
    const attempted = usageAttempts.get(snapshot.workspaceId);
    if (
      deferredDecision &&
      attempted?.revision === snapshot.revision &&
      nowBeforeObservation - attempted.at < 30_000
    )
      return deferredDecision;
    usageAttempts.set(snapshot.workspaceId, {
      revision: snapshot.revision,
      at: nowBeforeObservation,
    });
    let observed = yield* ports.observe(snapshot.workspaceId);
    if (observed.kind === "running")
      yield* ports
        .collectUsage(observed.client, false)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Periodic sandbox usage collection failed", { cause }),
          ),
        );
    const initialActivity = yield* activityGuard(snapshot);
    if (initialActivity !== null) return initialActivity;
    if (observed.kind === "stopped") {
      utilities.delete(snapshot.workspaceId);
      const settledAt = settlementAt(snapshot);
      if (snapshot.pendingEffects || snapshot.members.some(memberIsBusy)) return "busy" as const;
      if (settledAt === null) {
        usageAttempts.delete(snapshot.workspaceId);
        if (observed.completedStop) yield* ports.retire(snapshot, observed.completedStop);
        return "stopped" as const;
      }
      if (snapshot.settleScript && !snapshot.settlementProven) {
        const resumed = yield* ports.resume(snapshot.workspaceId);
        const fresh = yield* ports.read(threadId);
        if (
          !fresh ||
          settlementAt(fresh) !== settledAt ||
          fresh.pendingEffects ||
          fresh.members.some(memberIsBusy)
        )
          return "stale" as const;
        snapshot = fresh;
        observed = { kind: "running", client: resumed };
      } else {
        if (observed.phase === "released") {
          usageAttempts.delete(snapshot.workspaceId);
          if (observed.completedStop) yield* ports.retire(snapshot, observed.completedStop);
          return "stopped" as const;
        }
        if (observed.phase !== "suspended" || !observed.identity)
          return yield* new LifecyclePolicyError({
            operation: "release-suspended",
            cause: "Suspended identity is not established",
          });
        const fresh = yield* ports.read(threadId);
        if (
          !fresh ||
          fresh.revision !== snapshot.revision ||
          settlementAt(fresh) !== settledAt ||
          fresh.pendingEffects ||
          fresh.members.some(memberIsBusy)
        )
          return "stale" as const;
        const beforeRelease = yield* activityGuard(fresh);
        if (beforeRelease !== null) return beforeRelease;
        yield* ports.stop(
          fresh,
          "release_compute",
          `release:${snapshot.workspaceId}:${settledAt}:${observed.identity.allocationId}:${observed.identity.generation}:${observed.identity.incarnation}`,
          observed.identity,
        );
        return "release-submitted" as const;
      }
    }
    const client = observed.client;
    const now = yield* Clock.currentTimeMillis;
    let activityAt = lastActivity(snapshot);
    if (snapshot.kind === "utility") {
      const previous = utilities.get(snapshot.workspaceId);
      if (!previous || previous.incarnation !== client.identity.incarnation)
        utilities.set(snapshot.workspaceId, {
          incarnation: client.identity.incarnation,
          since: now,
        });
      activityAt = utilities.get(snapshot.workspaceId)?.since ?? now;
    }
    if (snapshot.pendingEffects || snapshot.members.some(memberIsBusy)) return "busy" as const;
    const settledAt = settlementAt(snapshot);
    if (settledAt === null && now - activityAt < ports.idleMs) return "grace" as const;
    const terminals = yield* invoke(client, "terminals.list", {}).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(TerminalSummary))),
      Effect.mapError(failure("terminal-activity")),
    );
    if (
      terminals.some((terminal) => terminal.status === "starting" || terminal.hasRunningSubprocess)
    )
      return "busy" as const;
    const threadIds = new Set([
      ...snapshot.members.map((member) => String(member.thread.id)),
      ...terminals.map((terminal) => terminal.threadId),
    ]);
    const beforeClose = yield* activityGuard(snapshot);
    if (beforeClose !== null) return beforeClose;
    for (const memberId of threadIds)
      yield* invoke(client, "terminals.closeIdle", { threadId: memberId });
    const afterClose = yield* ports.read(threadId);
    if (
      !afterClose ||
      afterClose.revision !== snapshot.revision ||
      afterClose.pendingEffects ||
      afterClose.members.some(memberIsBusy)
    )
      return "stale" as const;
    if (settledAt !== null && settlementAt(afterClose) !== settledAt) return "stale" as const;
    if (settledAt !== null && snapshot.settleScript) {
      const operationId = `settle:${threadId}:${settledAt}`;
      const deliveryId = `${operationId}:${client.identity.incarnation}`;
      const status = yield* Effect.tryPromise({
        try: () => client.operationStatus(deliveryId),
        catch: failure("settle-status"),
      });
      if (status.state === "running") return "script-running" as const;
      if (status.state === "unknown")
        return yield* new LifecyclePolicyError({
          operation: "settle-outcome",
          cause: "Script outcome is unknown; compute retained",
        });
      let value: unknown;
      if (status.state === "completed") {
        if (!status.result?.ok)
          return yield* new LifecyclePolicyError({
            operation: "settle-outcome",
            cause: status.result ?? "Missing script result",
          });
        value = status.result.value;
      } else {
        value = yield* invoke(
          client,
          "scripts.settle",
          { ...snapshot.settleScript, operationId },
          deliveryId,
        );
      }
      const result = yield* decodeScriptResult(value).pipe(
        Effect.mapError(failure("settle-result")),
      );
      if (result.code !== 0 || result.timedOut)
        return yield* new LifecyclePolicyError({ operation: "settle-script", cause: result });
    }
    yield* ports.collectUsage(client, true);
    const final = yield* ports.read(threadId);
    if (
      !final ||
      final.revision !== snapshot.revision ||
      final.pendingEffects ||
      final.members.some(memberIsBusy) ||
      settlementAt(final) !== settledAt
    )
      return "stale" as const;
    const latest = yield* ports.observe(snapshot.workspaceId);
    if (latest.kind === "stopped") return "stopped" as const;
    if (!sameIdentity(client.identity, latest.client.identity)) return "stale" as const;
    const action = settledAt === null ? "suspend" : "release_compute";
    const operationId =
      settledAt === null
        ? `idle:${snapshot.workspaceId}:${client.identity.incarnation}:${activityAt}`
        : `release:${snapshot.workspaceId}:${settledAt}:${client.identity.allocationId}:${client.identity.generation}:${client.identity.incarnation}`;
    const beforeStop = yield* activityGuard(final);
    if (beforeStop !== null) return beforeStop;
    yield* ports.stop(snapshot, action, operationId, client.identity);
    return action === "suspend" ? ("suspend-submitted" as const) : ("release-submitted" as const);
  });
  const scheduleReconciliation = Effect.fn("LifecyclePolicy.scheduleReconciliation")(function* (
    threadId: ThreadId,
  ) {
    if (!ports.enabled) return;
    if (inProgress.has(threadId)) return;
    inProgress.add(threadId);
    yield* reconcileThread(threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Workspace lifecycle attempt retained compute", { threadId, cause }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          inProgress.delete(threadId);
        }),
      ),
      Effect.forkIn(scope),
    );
  });
  const retryEnrollment = (effect: Effect.Effect<void, LifecyclePolicyError>) =>
    effect.pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.logWarning("Retrying workspace lifecycle enrollment", { cause }).pipe(
          Effect.as(false),
        ),
      ),
      Effect.repeat({ until: (accepted) => accepted, schedule: Schedule.spaced("1 second") }),
      Effect.asVoid,
    );
  const requestSettlement = Effect.fn("LifecyclePolicy.requestSettlement")(function* (
    threadId: ThreadId,
  ) {
    if (!ports.enabled) return;
    yield* retryEnrollment(ports.enroll(threadId));
    yield* scheduleReconciliation(threadId);
  });
  const start = ports.enabled
    ? retryEnrollment(ports.recoverSettlements).pipe(
        Effect.andThen(
          ports.roots.pipe(
            Effect.flatMap((roots) =>
              Effect.forEach(roots, scheduleReconciliation, { concurrency: 8, discard: true }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("Workspace lifecycle reconciliation failed", { cause }),
            ),
            Effect.repeat(Schedule.spaced("5 seconds")),
            Effect.forkScoped,
            Effect.asVoid,
          ),
        ),
      )
    : Effect.void;
  return LifecyclePolicy.of({ enabled: ports.enabled, reconcileThread, requestSettlement, start });
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runtime = yield* RuntimeClient.RuntimeClient;
  const history = yield* UsageHistory.UsageHistory;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const idleMs = yield* Config.Number("T3_SANDBOX_IDLE_MS").pipe(Config.withDefault(300_000));
  if (!Number.isFinite(idleMs) || idleMs < 0)
    return yield* Effect.die("T3_SANDBOX_IDLE_MS must be a nonnegative finite duration");
  const roots = Enrollment.roots.pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.mapError(failure("list-roots")),
  );
  const read = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        workspaceId: string;
        revision: number;
        threadId: string;
        receipt: string | null;
      }>`SELECT w.workspace_id AS workspaceId, w.admission_revision AS revision, b.thread_id AS threadId, w.lifecycle_request_json AS receipt
      FROM agent_runtime_workspaces w LEFT JOIN agent_runtime_thread_bindings b USING(workspace_id) WHERE w.owner_thread_id = ${threadId}`;
      const first = rows[0];
      if (!first) return null;
      if (first.workspaceId.startsWith("t3:utility:"))
        return {
          ownerThreadId: threadId,
          workspaceId: first.workspaceId,
          revision: first.revision,
          kind: "utility",
          members: [],
          pendingEffects: false,
          settleScript: null,
        } satisfies LifecycleSnapshot;
      const members: LifecycleMember[] = [];
      for (const row of rows) {
        const id = ThreadId.make(row.threadId);
        const shell = yield* projections.getThreadShell(id);
        const records = yield* projections.getThreadRecords(id, [
          "runs",
          "runtimeRequests",
          "providerThreads",
          "subagents",
          "messages",
        ]);
        if (!shell) {
          const busy =
            records.runs.some((run) =>
              run.status === "queued"
                ? run.queueHeld !== true
                : ["preparing", "starting", "running", "waiting"].includes(run.status),
            ) ||
            records.runtimeRequests.some(
              (request) =>
                request.status === "pending" && request.responseCapability.type !== "message",
            ) ||
            records.subagents.some((task) =>
              ["pending", "running", "waiting"].includes(task.status),
            ) ||
            records.providerThreads.some(
              (thread) => (thread.pendingBackgroundTasks ?? []).length > 0,
            );
          if (records.thread.deletedAt !== null && id !== threadId && !busy) continue;
          return null;
        }
        const adopted = new Set(records.runs.map((run) => String(run.userMessageId)));
        members.push({
          thread: shell,
          runs: records.runs,
          requests: records.runtimeRequests,
          subagents: records.subagents,
          nativeBackground: records.providerThreads.some(
            (thread) => (thread.pendingBackgroundTasks ?? []).length > 0,
          ),
          unassignedUserMessages: records.messages.some(
            (message) =>
              message.role === "user" &&
              message.runId === null &&
              !adopted.has(message.id) &&
              DateTime.toEpochMillis(message.createdAt) >= DateTime.toEpochMillis(shell.createdAt),
          ),
        });
      }
      const effects = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox e JOIN agent_runtime_thread_bindings b ON b.thread_id=e.thread_id WHERE b.workspace_id=${first.workspaceId} AND (e.status='running' OR (e.status='pending' AND julianday(e.available_at)<=julianday('now')))`;
      const root = members.find((member) => member.thread.id === threadId);
      if (!root) return null;
      let settleScript: LifecycleSnapshot["settleScript"] = null;
      if (root.thread.settledOverride === "settled") {
        const full = yield* projections.getThread(threadId);
        const project = yield* projects.getShell(full.projectId);
        if (Option.isNone(project)) return null;
        const config = yield* settings.getSettings;
        const script = settleProjectScript(resolveProjectScripts(config, project.value));
        if (script)
          settleScript = {
            cwd: full.worktreePath ?? project.value.workspaceRoot,
            command: "/bin/sh",
            args: ["-c", script.command],
            env: projectScriptRuntimeEnv({
              project: { cwd: project.value.workspaceRoot },
              worktreePath: full.worktreePath,
            }),
            timeoutMs: 3_600_000,
          };
      }
      const current = yield* sql<{
        revision: number;
      }>`SELECT admission_revision AS revision FROM agent_runtime_workspaces WHERE workspace_id=${first.workspaceId}`;
      if (current[0]?.revision !== first.revision) return null;
      const receipt =
        first.receipt === null
          ? null
          : yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(RuntimeClient.LifecycleStopRequest),
            )(first.receipt);
      const settledAt =
        root.thread.settledOverride === "settled" ? millis(root.thread.settledAt) : null;
      const settlementProven =
        settledAt !== null &&
        receipt?.action === "release_compute" &&
        receipt.operationId.startsWith(`release:${first.workspaceId}:${settledAt}:`);
      return {
        ownerThreadId: threadId,
        workspaceId: first.workspaceId,
        revision: first.revision,
        kind: "thread",
        members,
        pendingEffects: (effects[0]?.count ?? 1) > 0,
        settlementProven,
        settleScript,
      } satisfies LifecycleSnapshot;
    }).pipe(Effect.mapError(failure("snapshot")));
  return yield* makePolicy({
    enabled: runtime.enabled,
    idleMs,
    roots,
    read,
    recoverSettlements: Enrollment.recoverSettlements.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(failure("recover-settlements")),
    ),
    enroll: (threadId) =>
      Enrollment.enroll(threadId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(failure("enroll")),
      ),
    retire: (snapshot, completed) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const fresh = yield* read(snapshot.ownerThreadId);
            if (
              !fresh ||
              fresh.revision !== snapshot.revision ||
              fresh.pendingEffects ||
              fresh.members.some(memberIsBusy) ||
              settlementAt(fresh) !== settlementAt(snapshot)
            )
              return;
            const settledAt = settlementAt(fresh);
            if (
              settledAt !== null &&
              (completed.action !== "release_compute" ||
                (fresh.settleScript && !fresh.settlementProven))
            )
              return;
            yield* Enrollment.retire(fresh.workspaceId, fresh.revision, completed);
          }),
        )
        .pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(failure("retire"))),
    observe: (workspaceId) =>
      runtime.observeWorkspace(workspaceId).pipe(Effect.mapError(failure("observe"))),
    resume: (workspaceId) =>
      runtime.forWorkspace(workspaceId).pipe(Effect.mapError(failure("resume-cleanup"))),
    collectUsage: (client, force) =>
      history
        .collect(
          client,
          runtime
            .observeWorkspace(client.identity.workspaceId)
            .pipe(
              Effect.map((current) =>
                current.kind === "running" ? current.client.identity : null,
              ),
            ),
          force,
        )
        .pipe(Effect.mapError(failure("collect-usage"))),
    stop: (snapshot, action, operationId, identity) =>
      runtime
        .stop(snapshot.ownerThreadId, action, {
          operationId,
          expectedRevision: snapshot.revision,
          expectedIdentity: identity,
        })
        .pipe(Effect.mapError(failure("stop"))),
  });
});
export const layer = Layer.effect(LifecyclePolicy, make);
