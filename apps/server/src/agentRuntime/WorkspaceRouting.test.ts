import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Routing from "./WorkspaceRouting.ts";
import * as RuntimeClient from "./RuntimeClient.ts";
import * as RuntimeSchema from "./Schema.ts";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
it.layer(layer, { excludeTestServices: true })("registered workspace routing", (it) => {
  it.effect(
    "routes identical relative paths by durable workspace ownership and rejects central paths",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* RuntimeSchema.migrate;
        const calls: Array<{ workspaceId: string; method: string; input: unknown }> = [];
        const client = (workspaceId: string): ExecutionClient => ({
          credentialSource: () => {
            throw new Error("Credential forwarding is outside this workspace test");
          },
          identity: {
            workspaceId,
            generation: 1,
            allocationId: "1",
            incarnation: "worker",
            protocolVersion: 1,
            podUid: "pod",
          },
          call: async (method, input) => {
            calls.push({ workspaceId, method, input });
            return method === "workspace.isEmpty" || method === "git.isRepository"
              ? true
              : { contents: workspaceId };
          },
          events: async () => [],
          ack: async () => {},
          transient: async () => null,
          operationStatus: async () => ({ state: "missing" }),
          inspectIdentity: async () => ({
            workspaceId,
            generation: 1,
            allocationId: "1",
            incarnation: "worker",
            protocolVersion: 1,
            podUid: "pod",
          }),
        });
        const runtime = RuntimeClient.RuntimeClient.of({
          enabled: true,
          forWorkspace: (workspaceId) => Effect.succeed(client(workspaceId)),
          forThread: (threadId) => Effect.succeed(client(`t3:${threadId}`)),
          forUtility: (key) =>
            Effect.gen(function* () {
              const id = `t3:utility:${key}`;
              yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id) VALUES (${id},${key}) ON CONFLICT DO NOTHING`;
              return client(id);
            }).pipe(Effect.orDie),
          observeThread: () => Effect.succeed({ kind: "stopped" }),
          observeWorkspace: () => Effect.succeed({ kind: "stopped" }),
          sessionResidency: () => Effect.succeed(null),
          rememberSession: () => Effect.void,
          getEventCursor: () => Effect.succeed(0),
          stop: () => Effect.void,
        });
        const routes = yield* Routing.WorkspaceRouting.pipe(
          Effect.provide(Routing.layer),
          Effect.provideService(RuntimeClient.RuntimeClient, runtime),
        );
        const first = yield* routes.project("project-a", "https://github.com/example/a.git");
        const second = yield* routes.project("project-b", "https://github.com/example/b.git");
        expect(first).not.toBe(second);
        yield* routes.call({
          cwd: first,
          method: "files.read",
          input: { relativePath: "README.md" },
        });
        yield* routes.call({
          cwd: second,
          method: "files.read",
          input: { relativePath: "README.md" },
        });
        expect(calls.at(-2)?.workspaceId).toBe("t3:utility:project:project-a");
        expect(calls.at(-1)?.workspaceId).toBe("t3:utility:project:project-b");
        yield* routes.call({
          cwd: first,
          method: "files.browse",
          input: { partialPath: `${first}/src/` },
        });
        expect(calls.at(-1)).toMatchObject({
          workspaceId: "t3:utility:project:project-a",
          method: "files.browse",
          input: { cwd: first.slice("/workspace/".length), partialPath: "src/" },
        });
        const before = calls.length;
        yield* routes
          .call({
            cwd: "/tmp/central-trap",
            method: "files.write",
            input: { relativePath: "README.md", contents: "bad" },
          })
          .pipe(Effect.exit);
        yield* routes
          .call({ cwd: `${first}/../escape`, method: "files.read", input: {} })
          .pipe(Effect.exit);
        expect(calls.length).toBe(before);
        yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id) VALUES ('t3:root-a','root-a')`;
        yield* sql`INSERT INTO agent_runtime_thread_bindings(thread_id,workspace_id) VALUES ('root-a','t3:root-a'),('child-a','t3:root-a')`;
        const root = yield* routes.prepareThread({
          threadId: ThreadId.make("root-a"),
          projectCwd: first,
        });
        expect(root).not.toBe(first);
        const rows = yield* sql<{
          workspace_id: string;
        }>`SELECT workspace_id FROM agent_runtime_workspace_paths WHERE virtual_cwd=${root}`;
        expect(rows[0]?.workspace_id).toBe("t3:root-a");
        yield* routes
          .project("project-a", "https://github.com/example/other.git")
          .pipe(Effect.exit);
      }),
  );
});
