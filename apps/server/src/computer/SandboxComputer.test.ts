import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SandboxComputer from "./SandboxComputer.ts";
import * as RuntimeClient from "../agentRuntime/RuntimeClient.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { createExecutionClient } from "../execution/ExecutionClient.ts";

const scope = (threadId: string): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("env"),
  requestNamespace: `session-${threadId}`,
  issuedAt: 1,
  capabilities: new Set(["computer"]),
  client: undefined,
  thread: {
    threadId: ThreadId.make(threadId),
    providerSessionId: `session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
});
const status = {
  available: true,
  display: ":99",
  resolution: { width: 1440, height: 900 },
  capabilities: { screenshot: true, actions: true },
};

it.effect(
  "resolves the exact calling thread for every request across roots, children, and worker replacement",
  () =>
    Effect.gen(function* () {
      const calls: { workspaceId: string; incarnation: string }[] = [];
      const resolved: string[] = [];
      let incarnation = "first";
      let unavailable = false;
      const runtime = RuntimeClient.RuntimeClient.of({
        enabled: true,
        forThread: (threadId) =>
          Effect.gen(function* () {
            resolved.push(threadId);
            if (unavailable)
              return yield* new RuntimeClient.RuntimeClientError({
                operation: "resolve-binding",
                cause: "offline",
              });
            const identity = {
              workspaceId: threadId === "root-b" ? "workspace-b" : "workspace-a",
              allocationId: "allocation",
              generation: 1,
              incarnation,
              podUid: "pod",
              protocolVersion: 1,
            } satisfies Parameters<typeof createExecutionClient>[0]["identity"];
            return createExecutionClient({
              identity,
              endpoint: "http://worker.test",
              token: "test",
              fetch: async () => {
                calls.push({
                  workspaceId: identity.workspaceId,
                  incarnation: identity.incarnation,
                });
                return Response.json({ ok: true, value: status });
              },
            });
          }),
        forWorkspace: () => Effect.die("computer must resolve a thread"),
        forUtility: () => Effect.die("computer must not use a utility worker"),
        observeThread: () => Effect.die("unexpected observation"),
        observeWorkspace: () => Effect.die("unexpected observation"),
        sessionResidency: () => Effect.succeed(null),
        rememberSession: () => Effect.void,
        getEventCursor: () => Effect.succeed(0),
        stop: () => Effect.void,
      });
      const computer = yield* SandboxComputer.SandboxComputer.pipe(
        Effect.provide(SandboxComputer.layer),
        Effect.provideService(RuntimeClient.RuntimeClient, runtime),
      );
      for (const thread of ["root-a", "child-a", "root-b"]) {
        expect(
          yield* computer.status.pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope(thread)),
          ),
        ).toEqual(status);
      }
      incarnation = "replacement";
      yield* computer.status.pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope("child-a")),
      );
      expect(resolved).toEqual(["root-a", "child-a", "root-b", "child-a"]);
      expect(calls).toEqual([
        { workspaceId: "workspace-a", incarnation: "first" },
        { workspaceId: "workspace-a", incarnation: "first" },
        { workspaceId: "workspace-b", incarnation: "first" },
        { workspaceId: "workspace-a", incarnation: "replacement" },
      ]);
      for (const denied of [
        { ...scope("root-a"), capabilities: new Set<"computer">() },
        { ...scope("root-a"), thread: undefined },
      ]) {
        expect(
          yield* computer.status.pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, denied),
            Effect.flip,
          ),
        ).toMatchObject({ _tag: "McpCapabilityUnavailableError", capability: "computer" });
      }
      expect(resolved).toHaveLength(4);
      unavailable = true;
      expect(
        yield* computer.status.pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope("child-a")),
          Effect.flip,
        ),
      ).toMatchObject({ _tag: "SandboxComputerError" });
      expect(calls).toHaveLength(4);
    }),
);
