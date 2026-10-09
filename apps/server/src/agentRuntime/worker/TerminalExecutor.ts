import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as C from "@t3tools/contracts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as P from "./Protocol.ts";

/** One worker-owned manager; each terminal remains scoped to its originating thread. */
export const makeTerminalExecutor = <E, R>(options: {
  resolve: (relativePath: string) => Effect.Effect<string, E, R>;
  publish: (event: C.TerminalEvent) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const environment = yield* HostProcessEnvironment;
    const desktopEnvironment = (input: Readonly<Record<string, string>> | undefined) => {
      const env = { ...input };
      // Desktop processes belong to this worker, never to the requesting server or browser.
      for (const key of ["DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"]) {
        delete env[key];
        const value = environment[key];
        if (value !== undefined) env[key] = value;
      }
      return env;
    };
    const owned = new Map<string, { threadId: string; terminalId: string }>();
    const key = (threadId: string, terminalId: string) => JSON.stringify([threadId, terminalId]);
    const unsubscribe = yield* terminals.subscribe((event) =>
      Effect.gen(function* () {
        const id = key(event.threadId, event.terminalId);
        if (!owned.has(id)) return;
        if (event.type === "closed" || event.type === "exited") owned.delete(id);
        yield* options.publish(event);
      }),
    );
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        unsubscribe();
        for (const input of owned.values()) yield* terminals.close(input).pipe(Effect.ignore);
      }),
    );
    const requireOwned = (input: { threadId: string; terminalId: string }) =>
      Effect.gen(function* () {
        if (!owned.has(key(input.threadId, input.terminalId)))
          return yield* new P.WorkspaceExecutionError({ code: "terminal_not_owned" });
      });
    const execute = (method: string, raw: unknown) =>
      Effect.gen(function* () {
        switch (method) {
          case "terminals.open": {
            const input = yield* Schema.decodeUnknownEffect(C.TerminalOpenInput)(raw);
            const cwd = yield* options.resolve(input.cwd);
            const worktreePath = input.worktreePath
              ? yield* options.resolve(input.worktreePath)
              : null;
            const id = key(input.threadId, input.terminalId);
            owned.set(id, { threadId: input.threadId, terminalId: input.terminalId });
            return yield* terminals
              .open({ ...input, cwd, worktreePath, env: desktopEnvironment(input.env) })
              .pipe(Effect.tapError(() => Effect.sync(() => owned.delete(id))));
          }
          case "terminals.snapshot": {
            const input = yield* Schema.decodeUnknownEffect(C.TerminalObserveInput)(raw);
            const result = yield* Deferred.make<C.TerminalSessionSnapshot>();
            const unsubscribe = yield* terminals.observeStream(input, (event) =>
              event.type === "snapshot"
                ? Deferred.succeed(result, event.snapshot).pipe(Effect.asVoid)
                : Effect.void,
            );
            return yield* Deferred.await(result).pipe(Effect.ensuring(Effect.sync(unsubscribe)));
          }
          case "terminals.list": {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ threadId: Schema.optional(Schema.String) }),
            )(raw);
            const result = yield* Deferred.make<ReadonlyArray<C.TerminalSummary>>();
            const unsubscribe = yield* terminals.subscribeMetadata((event) =>
              event.type === "snapshot"
                ? Deferred.succeed(
                    result,
                    event.terminals.filter(
                      (terminal) => !input.threadId || terminal.threadId === input.threadId,
                    ),
                  ).pipe(Effect.asVoid)
                : Effect.void,
            );
            return yield* Deferred.await(result).pipe(Effect.ensuring(Effect.sync(unsubscribe)));
          }
          case "terminals.restart": {
            const input = yield* Schema.decodeUnknownEffect(C.TerminalRestartInput)(raw);
            const cwd = yield* options.resolve(input.cwd);
            const worktreePath = input.worktreePath
              ? yield* options.resolve(input.worktreePath)
              : null;
            owned.set(key(input.threadId, input.terminalId), {
              threadId: input.threadId,
              terminalId: input.terminalId,
            });
            return yield* terminals.restart({
              ...input,
              cwd,
              worktreePath,
              env: desktopEnvironment(input.env),
            });
          }
          case "terminals.write": {
            const input = yield* Schema.decodeUnknownEffect(C.TerminalWriteInput)(raw);
            yield* requireOwned(input);
            yield* terminals.write(input);
            return null;
          }
          case "terminals.resize": {
            const input = yield* Schema.decodeUnknownEffect(C.TerminalResizeInput)(raw);
            yield* requireOwned(input);
            yield* terminals.resize(input);
            return null;
          }
          case "terminals.clear": {
            const input = yield* Schema.decodeUnknownEffect(C.TerminalClearInput)(raw);
            yield* requireOwned(input);
            yield* terminals.clear(input);
            return null;
          }
          case "terminals.closeIdle": {
            const input = yield* Schema.decodeUnknownEffect(C.TerminalCloseInput)(raw);
            for (const terminal of owned.values())
              if (
                terminal.threadId === input.threadId &&
                (!input.terminalId || terminal.terminalId === input.terminalId)
              )
                yield* terminals.closeIdle(terminal);
            return null;
          }
          case "terminals.close": {
            const input = yield* Schema.decodeUnknownEffect(C.TerminalCloseInput)(raw);
            const matches = Array.from(owned.entries()).filter(
              ([, terminal]) =>
                terminal.threadId === input.threadId &&
                (!input.terminalId || terminal.terminalId === input.terminalId),
            );
            for (const [id, terminal] of matches) {
              yield* terminals.close({ ...terminal, deleteHistory: input.deleteHistory });
              owned.delete(id);
            }
            return null;
          }
          default:
            return yield* new P.WorkspaceExecutionError({ code: "unsupported_terminal_method" });
        }
      });
    return {
      execute,
      activity: Effect.sync(() => ({ activeOperations: owned.size, pendingCallbacks: 0 })),
    };
  });
