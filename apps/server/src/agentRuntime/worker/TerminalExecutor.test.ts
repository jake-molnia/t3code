import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as C from "@t3tools/contracts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { makeTerminalExecutor } from "./TerminalExecutor.ts";

it.effect("keeps child terminal ownership separate and retains uncertain error activity", () =>
  Effect.gen(function* () {
    let listener: (event: C.TerminalEvent) => Effect.Effect<void> = () => Effect.void;
    const closed: string[] = [];
    const openedEnvironments: unknown[] = [];
    const writes: string[] = [];
    const published: C.TerminalEvent[] = [];
    const terminalService = TerminalManager.TerminalManager.of({
      open: (input) =>
        Effect.sync(() => {
          openedEnvironments.push(input.env);
          return {
            threadId: input.threadId,
            terminalId: input.terminalId,
            cwd: input.cwd,
            worktreePath: null,
            status: "running",
            pid: 123,
            history: "",
            exitCode: null,
            exitSignal: null,
            label: "shell",
            updatedAt: "2026-10-08T00:00:00Z",
          };
        }),
      write: (input) =>
        Effect.sync(() => {
          writes.push(input.threadId);
        }),
      close: (input) =>
        Effect.sync(() => {
          closed.push(input.threadId);
        }),
      resize: () => Effect.void,
      clear: () => Effect.void,
      closeIdle: () => Effect.void,
      restart: (input) => terminalService.open(input),
      attachStream: () => Effect.die("unexpected attach"),
      observeStream: () => Effect.die("unexpected observe"),
      subscribe: (next) =>
        Effect.sync(() => {
          listener = next;
          return () => {};
        }),
      subscribeMetadata: () => Effect.succeed(() => {}),
    });
    const executor = yield* makeTerminalExecutor({
      resolve: (cwd) => Effect.succeed(`/workspace/${cwd}`),
      publish: (event) =>
        Effect.sync(() => {
          published.push(event);
        }),
    }).pipe(
      Effect.provideService(TerminalManager.TerminalManager, terminalService),
      Effect.provideService(HostProcess.Environment, {
        DISPLAY: ":99",
        XAUTHORITY: "/sandbox/.Xauthority",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/sandbox/bus",
        XDG_RUNTIME_DIR: "/run/sandbox",
      }),
    );
    for (const threadId of ["parent", "child"])
      yield* executor.execute("terminals.open", {
        threadId,
        terminalId: "shell",
        cwd: "repo",
        env: {
          DISPLAY: ":0",
          XAUTHORITY: "/central/.Xauthority",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/central/bus",
          XDG_RUNTIME_DIR: "/run/central",
          CUSTOM: threadId,
        },
      });
    yield* executor.execute("terminals.restart", {
      threadId: "child",
      terminalId: "shell",
      cwd: "repo",
      cols: 80,
      rows: 24,
      env: { DISPLAY: ":123", CUSTOM: "child" },
    });
    expect(openedEnvironments).toEqual(
      ["parent", "child", "child"].map((threadId) => ({
        DISPLAY: ":99",
        XAUTHORITY: "/sandbox/.Xauthority",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/sandbox/bus",
        XDG_RUNTIME_DIR: "/run/sandbox",
        CUSTOM: threadId,
      })),
    );
    expect(yield* executor.activity).toEqual({ activeOperations: 2, pendingCallbacks: 0 });
    expect(
      yield* executor
        .execute("terminals.write", { threadId: "stranger", terminalId: "shell", data: "pwd\n" })
        .pipe(Effect.flip),
    ).toMatchObject({ code: "terminal_not_owned" });
    yield* executor.execute("terminals.write", {
      threadId: "child",
      terminalId: "shell",
      data: "pwd\n",
    });
    yield* executor.execute("terminals.close", { threadId: "parent" });
    expect(writes).toEqual(["child"]);
    expect(closed).toEqual(["parent"]);
    yield* listener({
      type: "error",
      threadId: "child",
      terminalId: "shell",
      message: "inspection unavailable",
    });
    expect((yield* executor.activity).activeOperations).toBe(1);
    yield* listener({ type: "output", threadId: "stranger", terminalId: "shell", data: "private" });
    expect(published).toHaveLength(1);
    yield* listener({
      type: "exited",
      threadId: "child",
      terminalId: "shell",
      exitCode: 0,
      exitSignal: null,
    });
    expect((yield* executor.activity).activeOperations).toBe(0);
  }).pipe(Effect.scoped),
);
