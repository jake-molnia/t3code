// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Node transport and durable journal boundary, also consumed outside Effect.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import {
  ExecutionOperation,
  ExecutionIdentity,
  type ExecutionResult,
} from "../../../../packages/contracts/src/execution.ts";
import { JournalCapacityError, type WorkerJournal } from "./WorkerJournal.ts";

const decodeExecutionOperationSync = Schema.decodeUnknownSync(ExecutionOperation);

const READ_ONLY_EXECUTION_METHODS = new Set([
  "git.driver.readConfigValue",
  "git.driver.listRefs",
  "git.driver.resolveCommit",
  "git.driver.remoteExists",
  "git.driver.remoteBranchExists",
  "git.driver.listWorktreePaths",
  "git.driver.listLocalBranchNames",
  "git.driver.readInstructions",
  "git.driver.readRangeContext",
  "git.driver.getReviewDiffPreview",
  "git.driver.getReviewDiffFileContents",
  "git.driver.status",
  "git.driver.statusDetailsLocal",
  "closeSession",
  "git.cleanupFork",
  "project.file",
  "project.repositoryIdentity",
  "project.favicon",
  "getCapabilities",
  "planSelectionTransition",
  "describeSession",
  "modelContext",
  "hasPendingBackgroundWork",
  "hasPendingBackgroundWorkForThread",
  "readThreadSnapshot",
  "provider.snapshot",
  "provider.snapshotForCwd",
  "provider.refresh",
  "auth.state",
  "files.read",
  "files.metadata",
  "usage.history",
  "usage.read",
  "usage.release",
  "files.list",
  "files.browse",
  "files.search",
  "files.searchContents",
  "git.isRepository",
  "git.hasCheckpoint",
  "git.listRefs",
  "git.diffFileContents",
  "git.status",
  "git.diff",
  "git.diffCheckpoints",
  "workspace.isEmpty",
  "preview.status",
  "preview.list",
  "preview.snapshot",
  "preview.screenshot",
  "computer.status",
  "computer.screenshot",
  "terminals.list",
  "terminals.snapshot",
]);

export function sameIdentity(a: ExecutionIdentity, b: ExecutionIdentity) {
  return (
    a.podUid === b.podUid &&
    a.allocationId === b.allocationId &&
    a.protocolVersion === b.protocolVersion &&
    a.workspaceId === b.workspaceId &&
    a.generation === b.generation &&
    a.incarnation === b.incarnation
  );
}
function digest(text: string) {
  return NodeCrypto.createHash("sha256").update(text).digest();
}
export function authorized(actual: string | null, token: string) {
  return NodeCrypto.timingSafeEqual(digest(actual ?? ""), digest(`Bearer ${token}`));
}

/** The operation handler owns decoding of its method-specific input. */
export function createExecutionWorker(options: {
  identity: ExecutionIdentity;
  token: string;
  journal: WorkerJournal;
  activity?: () => Promise<{ activeOperations: number; pendingCallbacks: number }>;
  execute: (method: string, input: unknown) => Promise<unknown>;
}) {
  if (options.token.length < 32)
    throw new Error("Worker token must contain at least 32 characters");
  const inFlight = new Map<string, Promise<ExecutionResult>>();
  let admission = Promise.resolve();
  let exclusiveOperation: string | undefined;
  let activeTransient = 0;
  let activeLeases = 0;
  const readers = new Set<{ sessionId: string | null; wake: () => void }>();
  let eventWrites = Promise.resolve();
  let quiescent = false;
  let revision = 0;
  let lastLifecycle: { revision: number; action: string; operationId: string } | undefined;
  const Lifecycle = Schema.Struct({
    identity: ExecutionIdentity,
    revision: Schema.Number,
    operationId: Schema.String,
  });
  let sequence = options.journal.lastSequence;
  async function perform(operation: ExecutionOperation): Promise<ExecutionResult> {
    if (
      [
        "vcs.process.probe",
        "preview.viewerPoll",
        "preview.viewerInput",
        "preview.viewerAck",
        "asset.read",
        "asset.stage",
        "input.stage",
      ].includes(operation.method) ||
      operation.method.startsWith("auth.") ||
      operation.method === "configureProvider"
    )
      return { ok: false, code: "transient_required" };
    if (!sameIdentity(options.identity, operation.identity))
      return { ok: false, code: "stale_identity" };
    const fingerprint = digest(
      JSON.stringify([operation.identity, operation.method, operation.input]),
    ).toString("hex");
    let run: Promise<ExecutionResult> | undefined;
    const accepted = admission.then(async () => {
      const previous = options.journal.operations.get(operation.operationId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          run = Promise.resolve({ ok: false, code: "operation_conflict" });
          return;
        }
        run =
          inFlight.get(operation.operationId) ??
          Promise.resolve(previous.result ?? { ok: false, code: "operation_outcome_unknown" });
        return;
      }
      if (exclusiveOperation !== undefined) {
        run = Promise.resolve({ ok: false, code: "worker_exclusive_operation" });
        return;
      }
      if (["git.restore", "scripts.settle", "workspace.discardClone"].includes(operation.method)) {
        const activity = (await options.activity?.()) ?? {
          activeOperations: 0,
          pendingCallbacks: 0,
        };
        if (
          inFlight.size ||
          activeTransient ||
          activeLeases ||
          activity.activeOperations ||
          activity.pendingCallbacks
        ) {
          run = Promise.resolve({ ok: false, code: "worker_busy" });
          return;
        }
      }
      if (quiescent) {
        run = Promise.resolve({ ok: false, code: "worker_quiescent" });
        return;
      }

      const journaled = !READ_ONLY_EXECUTION_METHODS.has(operation.method);
      if (journaled) {
        try {
          await options.journal.append({
            kind: "accepted",
            id: operation.operationId,
            fingerprint,
            incarnation: options.identity.incarnation,
          });
        } catch (error) {
          if (!(error instanceof JournalCapacityError)) throw error;
          run = Promise.resolve({ ok: false, code: "journal_capacity" });
          return;
        }
      }
      if (["git.restore", "scripts.settle", "workspace.discardClone"].includes(operation.method))
        exclusiveOperation = operation.operationId;
      run = (async (): Promise<ExecutionResult> => {
        let result: ExecutionResult;
        try {
          result = {
            ok: true,
            value: (await options.execute(operation.method, operation.input)) ?? null,
          };
        } catch {
          result = { ok: false, code: "operation_failed" };
        }
        if (journaled)
          await options.journal.append({ kind: "completed", id: operation.operationId, result });
        return result;
      })();
      inFlight.set(operation.operationId, run);
      void run
        .finally(() => {
          inFlight.delete(operation.operationId);
          if (exclusiveOperation === operation.operationId) exclusiveOperation = undefined;
        })
        .catch(() => {});
    });
    admission = accepted.catch(() => {});
    await accepted;
    if (!run) throw new Error("Operation admission failed");
    return run;
  }
  return {
    identity: options.identity,
    /** Streaming transports share the same admission barrier as operations and lifecycle changes. */
    async acquireLease(): Promise<(() => void) | undefined> {
      let release: (() => void) | undefined;
      const accepted = admission.then(() => {
        if (quiescent || exclusiveOperation !== undefined) return;
        activeLeases++;
        let released = false;
        release = () => {
          if (released) return;
          released = true;
          activeLeases--;
        };
      });
      admission = accepted.catch(() => {});
      await accepted;
      return release;
    },
    publish(sessionId: string, event: unknown) {
      const write = eventWrites.then(() =>
        options.journal.append({
          kind: "event",
          envelope: {
            identity: options.identity,
            sequence: ++sequence,
            sessionId,
            event,
          },
        }),
      );
      eventWrites = write.catch((error) => {
        if (!(error instanceof JournalCapacityError)) throw error;
      });
      return write.then(() => {
        for (const reader of readers)
          if (reader.sessionId === null || reader.sessionId === sessionId) reader.wake();
      });
    },
    async handle(request: Request): Promise<Response> {
      if (!authorized(request.headers.get("authorization"), options.token))
        return new Response(null, { status: 401 });
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/transient") {
        const Input = Schema.Struct({
          identity: ExecutionIdentity,
          method: Schema.String,
          input: Schema.Unknown,
        });
        const permitted = (method: string) =>
          method.startsWith("auth.") ||
          method === "configureProvider" ||
          [
            "vcs.process.probe",
            "preview.viewerPoll",
            "preview.viewerInput",
            "preview.viewerAck",
            "asset.read",
            "asset.stage",
            "input.stage",
          ].includes(method);
        let input: typeof Input.Type;
        try {
          input = Schema.decodeUnknownSync(Input)(await request.json());
        } catch {
          return new Response(null, { status: 400 });
        }
        if (!permitted(input.method)) return new Response(null, { status: 400 });
        if (!sameIdentity(input.identity, options.identity))
          return Response.json({ ok: false, code: "stale_identity" }, { status: 409 });
        const mutation =
          input.method === "vcs.process.probe" ||
          input.method === "preview.viewerInput" ||
          input.method === "asset.stage" ||
          input.method === "input.stage" ||
          input.method === "configureProvider" ||
          (input.method.startsWith("auth.") && input.method !== "auth.state");
        let accepted = false;
        const admit = admission.then(() => {
          if (mutation && (quiescent || exclusiveOperation !== undefined)) return;
          if (mutation) activeTransient++;
          accepted = true;
        });
        admission = admit.catch(() => {});
        await admit;
        if (!accepted)
          return Response.json({ ok: false, code: "worker_not_admitting" }, { status: 409 });
        try {
          return Response.json({
            ok: true,
            value: (await options.execute(input.method, input.input)) ?? null,
          });
        } catch {
          return Response.json({ ok: false, code: "operation_failed" }, { status: 422 });
        } finally {
          if (mutation) activeTransient--;
        }
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/operations/")) {
        const id = decodeURIComponent(url.pathname.slice("/v1/operations/".length));
        const operation = options.journal.operations.get(id);
        return Response.json(
          !operation
            ? { state: "missing" }
            : operation.result
              ? { state: "completed", result: operation.result }
              : { state: inFlight.has(id) ? "running" : "unknown" },
        );
      }
      if (request.method === "GET" && url.pathname === "/v1/identity")
        return Response.json(options.identity);
      if (
        request.method === "POST" &&
        (url.pathname === "/v1/quiesce" || url.pathname === "/v1/resume")
      ) {
        let input: typeof Lifecycle.Type;
        try {
          input = Schema.decodeUnknownSync(Lifecycle)(await request.json());
        } catch {
          return new Response(null, { status: 400 });
        }
        if (
          !sameIdentity(input.identity, options.identity) ||
          !Number.isSafeInteger(input.revision) ||
          input.revision < revision
        )
          return new Response(null, { status: 409 });
        let response: Response | undefined;
        const transition = admission.then(async () => {
          if (input.revision < revision) {
            response = new Response(null, { status: 409 });
            return;
          }
          if (
            lastLifecycle?.revision === input.revision &&
            (lastLifecycle.action !== url.pathname ||
              lastLifecycle.operationId !== input.operationId)
          ) {
            response = new Response(null, { status: 409 });
            return;
          }
          const activity = (await options.activity?.()) ?? {
            activeOperations: 0,
            pendingCallbacks: 0,
          };
          if (
            url.pathname === "/v1/quiesce" &&
            (inFlight.size ||
              activeTransient ||
              activeLeases ||
              activity.activeOperations ||
              activity.pendingCallbacks)
          ) {
            response = Response.json(
              {
                ...options.identity,
                ...activity,
                activeOperations:
                  activity.activeOperations + inFlight.size + activeTransient + activeLeases,
                quiescent: false,
                revision,
              },
              { status: 409 },
            );
            return;
          }
          revision = input.revision;
          lastLifecycle = { revision, action: url.pathname, operationId: input.operationId };
          quiescent = url.pathname === "/v1/quiesce";
          await eventWrites;
          response = Response.json({
            ...options.identity,
            revision,
            quiescent,
            activeOperations: 0,
            pendingCallbacks: 0,
          });
        });
        admission = transition.catch(() => {});
        await transition;
        return response ?? new Response(null, { status: 500 });
      }
      if (request.method === "POST" && url.pathname === "/v1/events/ack") {
        let input: { identity: ExecutionIdentity; sessionId: string; sequence: number };
        try {
          input = Schema.decodeUnknownSync(
            Schema.Struct({
              identity: ExecutionIdentity,
              sessionId: Schema.String,
              sequence: Schema.Number,
            }),
          )(await request.json());
        } catch {
          return new Response(null, { status: 400 });
        }
        if (!sameIdentity(input.identity, options.identity))
          return new Response(null, { status: 409 });
        try {
          await options.journal.acknowledge(
            input.identity.incarnation,
            input.sessionId,
            input.sequence,
          );
        } catch {
          return new Response(null, { status: 400 });
        }
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET" && url.pathname === "/v1/events") {
        const after = Number(url.searchParams.get("after") ?? "0");
        if (!Number.isSafeInteger(after) || after < 0) return new Response(null, { status: 400 });
        const sessionId = url.searchParams.get("sessionId");
        const collect = () => {
          const events = options.journal.eventsFor(
            sessionId ?? undefined,
            options.identity.incarnation,
          );
          let lower = 0,
            upper = events.length;
          while (lower < upper) {
            const middle = Math.floor((lower + upper) / 2);
            if ((events[middle]?.sequence ?? 0) <= after) lower = middle + 1;
            else upper = middle;
          }
          const batch = [];
          for (let index = lower; index < events.length && batch.length < 256; index++) {
            const event = events[index];
            if (
              event &&
              sameIdentity(event.identity, options.identity) &&
              !options.journal.isAcknowledged(event)
            )
              batch.push(event);
          }
          return batch;
        };
        let batch = collect();
        const waitMs = Math.min(25_000, Math.max(0, Number(url.searchParams.get("waitMs") ?? 0)));
        if (!batch.length && waitMs > 0 && Number.isFinite(waitMs)) {
          await new Promise<void>((resolve) => {
            const reader = {
              sessionId,
              wake: () => {
                clearTimeout(timer);
                readers.delete(reader);
                request.signal.removeEventListener("abort", reader.wake);
                resolve();
              },
            };
            const timer = setTimeout(reader.wake, waitMs);
            readers.add(reader);
            request.signal.addEventListener("abort", reader.wake, { once: true });
            if (request.signal.aborted) reader.wake();
          });
          batch = collect();
        }
        return Response.json({ identity: options.identity, events: batch });
      }
      if (request.method !== "POST" || url.pathname !== "/v1/operations")
        return new Response(null, { status: 404 });
      let operation: ExecutionOperation;
      try {
        operation = decodeExecutionOperationSync(await request.json());
      } catch {
        return new Response(null, { status: 400 });
      }
      const result = await perform(operation);
      return Response.json(result, {
        status: result.ok ? 200 : result.code === "stale_identity" ? 409 : 422,
      });
    },
  };
}
export type ExecutionWorker = ReturnType<typeof createExecutionWorker>;
