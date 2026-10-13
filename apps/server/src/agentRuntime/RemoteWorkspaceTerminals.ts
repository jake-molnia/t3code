import { withWorkspaceActivity } from "./WorkspaceActivity.ts";
import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as RuntimeClient from "./RuntimeClient.ts";
import * as WorkspaceRouting from "./WorkspaceRouting.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export const layer = Layer.effect(
  TerminalManager.TerminalManager,
  Effect.gen(function* () {
    const runtime = yield* RuntimeClient.RuntimeClient;
    const routes = yield* WorkspaceRouting.WorkspaceRouting;
    const scope = yield* Effect.scope;
    const watchers = new Set<string>();
    const pins = new Map<string, number>();
    const pin = (threadId: string) => {
      pins.set(threadId, (pins.get(threadId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (pins.get(threadId) ?? 1) - 1;
        if (remaining === 0) pins.delete(threadId);
        else pins.set(threadId, remaining);
      };
    };
    const summaries = new Map<string, C.TerminalSummary>();
    const listeners = new Set<(event: C.TerminalEvent) => Effect.Effect<void>>();
    const metadataListeners = new Set<
      (event: C.TerminalMetadataStreamEvent) => Effect.Effect<void>
    >();
    const key = (threadId: string, terminalId: string) => `${threadId}\0${terminalId}`;
    const lookupError = (threadId: string, terminalId = "default") =>
      new C.TerminalSessionLookupError({ threadId, terminalId });
    const notifyMetadata = (event: C.TerminalMetadataStreamEvent) =>
      Effect.forEach(metadataListeners, (listener) => listener(event), { discard: true });
    const publish = (event: C.TerminalEvent) =>
      Effect.gen(function* () {
        const id = key(event.threadId, event.terminalId);
        if (event.type === "started" || event.type === "restarted") {
          const summary = { ...event.snapshot, hasRunningSubprocess: true };
          summaries.set(id, summary);
          yield* notifyMetadata({ type: "upsert", terminal: summary });
        } else if (event.type === "closed") {
          summaries.delete(id);
          yield* notifyMetadata({
            type: "remove",
            threadId: event.threadId,
            terminalId: event.terminalId,
          });
        } else {
          const previous = summaries.get(id);
          if (previous && event.type === "activity") {
            const next = {
              ...previous,
              hasRunningSubprocess: event.hasRunningSubprocess,
              label: event.label,
            };
            summaries.set(id, next);
            yield* notifyMetadata({ type: "upsert", terminal: next });
          }
          if (previous && event.type === "exited") {
            const next: C.TerminalSummary = {
              ...previous,
              status: "exited",
              pid: null,
              hasRunningSubprocess: false,
              exitCode: event.exitCode,
              exitSignal: event.exitSignal,
            };
            summaries.set(id, next);
            yield* notifyMetadata({ type: "upsert", terminal: next });
          }
        }
        yield* Effect.forEach(listeners, (listener) => listener(event), { discard: true });
      });
    const watch = (threadId: string) =>
      Effect.gen(function* () {
        if (watchers.has(threadId)) return;
        watchers.add(threadId);
        let cursor = 0;
        let incarnation: string | undefined;
        // Observation cannot create a worker. A pending/replaced worker is recovered
        // by open below; keep its event watcher alive while that acquisition runs.
        yield* Effect.gen(function* () {
          const initial = yield* runtime.observeThread(C.ThreadId.make(threadId));
          if (initial.kind === "running") {
            const baseline = yield* Effect.tryPromise(() =>
              initial.client.events(0, undefined, `terminal:${threadId}`),
            );
            cursor = baseline.at(-1)?.sequence ?? 0;
            incarnation = initial.client.identity.incarnation;
            const metadata = yield* Effect.tryPromise(() =>
              initial.client.call("terminals.list", { threadId }),
            ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(C.TerminalSummary))));
            for (const summary of metadata) {
              summaries.set(key(summary.threadId, summary.terminalId), summary);
              yield* notifyMetadata({ type: "upsert", terminal: summary });
            }
            if (cursor > 0)
              yield* Effect.tryPromise(() => initial.client.ack(`terminal:${threadId}`, cursor));
          }
        }).pipe(Effect.ignore);
        yield* Effect.gen(function* () {
          while (true) {
            yield* Effect.gen(function* () {
              const observed = yield* runtime.observeThread(C.ThreadId.make(threadId));
              if (observed.kind === "running") {
                if (incarnation !== observed.client.identity.incarnation) {
                  if (incarnation !== undefined)
                    for (const summary of Array.from(summaries.values()))
                      if (summary.threadId === threadId)
                        yield* publish({
                          type: "closed",
                          threadId,
                          terminalId: summary.terminalId,
                        });
                  incarnation = observed.client.identity.incarnation;
                  cursor = 0;
                }
                const events = yield* Effect.tryPromise(() =>
                  observed.client.events(cursor, undefined, `terminal:${threadId}`),
                );
                for (const envelope of events) {
                  if (
                    envelope.sessionId === `terminal:${threadId}` &&
                    envelope.identity.incarnation === incarnation
                  ) {
                    const event = yield* Schema.decodeUnknownEffect(C.TerminalEvent)(
                      envelope.event,
                    );
                    if (event.threadId !== threadId)
                      return yield* Effect.die("Worker terminal thread identity mismatch");
                    yield* publish(event);
                  }
                  cursor = Math.max(cursor, envelope.sequence);
                }
                if (cursor > 0)
                  yield* Effect.tryPromise(() =>
                    observed.client.ack(`terminal:${threadId}`, cursor),
                  );
              } else {
                for (const summary of Array.from(summaries.values()))
                  if (
                    summary.threadId === threadId &&
                    (summary.status === "running" || summary.status === "starting")
                  )
                    yield* publish({
                      type: "exited",
                      threadId,
                      terminalId: summary.terminalId,
                      exitCode: null,
                      exitSignal: null,
                    });
              }
            }).pipe(Effect.catchCause(() => Effect.void));
            const active = Array.from(summaries.values()).some(
              (summary) =>
                summary.threadId === threadId &&
                (summary.status === "running" || summary.status === "starting"),
            );
            if (!active && !pins.has(threadId)) return;
            yield* Effect.sleep(active ? "100 millis" : "2 seconds");
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Remote terminal event transport stopped", { threadId, cause }),
          ),
          Effect.ensuring(Effect.sync(() => watchers.delete(threadId))),
          Effect.forkIn(scope),
        );
      }).pipe(Effect.onError(() => Effect.sync(() => watchers.delete(threadId))));
    const invoke = <A, I>(
      method: string,
      input: { threadId: string; terminalId?: string | undefined },
      schema: Schema.Codec<A, I>,
    ) =>
      Effect.gen(function* () {
        const observed = yield* runtime.observeThread(C.ThreadId.make(input.threadId));
        if (observed.kind === "stopped")
          return yield* lookupError(input.threadId, input.terminalId);
        return yield* Effect.tryPromise(() => observed.client.call(method, input)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(schema)),
        );
      }).pipe(Effect.mapError(() => lookupError(input.threadId, input.terminalId)));
    const interactive = <A, I>(
      method: string,
      input: { threadId: string; terminalId?: string | undefined },
      schema: Schema.Codec<A, I>,
    ) =>
      routes.describeBoundThread(C.ThreadId.make(input.threadId)).pipe(
        Effect.flatMap((binding) =>
          withWorkspaceActivity(binding.workspaceId, invoke(method, input, schema)),
        ),
        Effect.mapError(() => lookupError(input.threadId, input.terminalId)),
      );
    const open: TerminalManager.TerminalManager["Service"]["open"] = (input) =>
      Effect.acquireUseRelease(
        Effect.sync(() => pin(input.threadId)),
        () =>
          Effect.gen(function* () {
            yield* watch(input.threadId);
            const value = yield* routes
              .callThread(C.ThreadId.make(input.threadId), "terminals.open", { ...input })
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(C.TerminalSessionSnapshot)));
            summaries.set(key(input.threadId, input.terminalId), {
              ...value,
              hasRunningSubprocess: value.status === "running",
            });
            yield* watch(input.threadId);
            return value;
          }),
        (release) => Effect.sync(release),
      ).pipe(Effect.mapError((cause) => new C.TerminalCwdStatError({ cwd: input.cwd, cause })));
    const subscribe: TerminalManager.TerminalManager["Service"]["subscribe"] = (listener) =>
      Effect.gen(function* () {
        listeners.add(listener);
        const unsubscribe = () => {
          listeners.delete(listener);
        };
        return unsubscribe;
      });
    const attach = (
      input: C.TerminalAttachInput,
      listener: (event: C.TerminalAttachStreamEvent) => Effect.Effect<void>,
      allowOpen: boolean,
    ) =>
      Effect.gen(function* () {
        const release = pin(input.threadId);
        yield* watch(input.threadId).pipe(Effect.tapError(() => Effect.sync(release)));
        let sequence = -1;
        let ready = false;
        const buffered: C.TerminalEvent[] = [];
        const forward = (event: C.TerminalEvent) =>
          Effect.gen(function* () {
            if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) return;
            if (!ready) {
              buffered.push(event);
              return;
            }
            if (event.sequence !== undefined && event.sequence <= sequence) return;
            if (event.type === "closed") {
              sequence = -1;
              yield* listener(event);
              return;
            }
            if (event.type === "started") {
              sequence = event.snapshot.sequence ?? -1;
              yield* listener({ type: "snapshot", snapshot: event.snapshot });
              return;
            }
            if (event.sequence !== undefined) sequence = event.sequence;
            yield* listener(event);
          });
        const removeListener = yield* subscribe(forward);
        const unsubscribe = () => {
          removeListener();
          release();
        };
        const snapshot = yield* invoke("terminals.snapshot", input, C.TerminalSessionSnapshot).pipe(
          Effect.catch((error) =>
            allowOpen && input.cwd ? open({ ...input, cwd: input.cwd }) : Effect.fail(error),
          ),
          Effect.flatMap((snapshot) =>
            allowOpen &&
            input.cwd &&
            input.restartIfNotRunning === true &&
            (snapshot.status === "exited" || snapshot.status === "error")
              ? open({ ...input, cwd: input.cwd })
              : Effect.succeed(snapshot),
          ),
          Effect.tapError(() => Effect.sync(unsubscribe)),
        );
        sequence = snapshot.sequence ?? -1;
        yield* listener({ type: "snapshot", snapshot });
        ready = true;
        for (const event of buffered) yield* forward(event);
        return unsubscribe;
      }).pipe(Effect.mapError(() => lookupError(input.threadId, input.terminalId)));
    return TerminalManager.TerminalManager.of({
      open,
      attachStream: (input, listener) => attach(input, listener, true),
      observeStream: (input, listener) => attach(input, listener, false),
      write: (input) => interactive("terminals.write", input, Schema.Null).pipe(Effect.asVoid),
      resize: (input) => interactive("terminals.resize", input, Schema.Null).pipe(Effect.asVoid),
      clear: (input) => interactive("terminals.clear", input, Schema.Null).pipe(Effect.asVoid),
      restart: (input) =>
        routes.callThread(C.ThreadId.make(input.threadId), "terminals.restart", { ...input }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(C.TerminalSessionSnapshot)),
          Effect.mapError(() => lookupError(input.threadId, input.terminalId)),
        ),
      close: (input) =>
        Effect.gen(function* () {
          const observed = yield* runtime.observeThread(C.ThreadId.make(input.threadId));
          if (observed.kind === "stopped") return;
          yield* Effect.tryPromise(() => observed.client.call("terminals.close", input));
        }).pipe(Effect.mapError(() => lookupError(input.threadId, input.terminalId))),
      closeIdle: (input) =>
        invoke("terminals.closeIdle", input, Schema.Null).pipe(Effect.asVoid, Effect.ignore),
      subscribe,
      subscribeMetadata: (listener) =>
        Effect.gen(function* () {
          metadataListeners.add(listener);
          const unsubscribe = () => {
            metadataListeners.delete(listener);
          };
          yield* listener({ type: "snapshot", terminals: Array.from(summaries.values()) });
          return unsubscribe;
        }),
    });
  }),
);
