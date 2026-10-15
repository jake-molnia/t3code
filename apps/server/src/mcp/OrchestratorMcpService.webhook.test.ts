import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as PublicAddress from "../environment/PublicAddress.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const decodePublicUrl = Schema.decodeSync(PublicAddress.PublicUrl);

const projectId = ProjectId.make("project:webhook-url");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:webhook-url"),
  requestNamespace: "client:webhook-url",
  thread: undefined,
  client: { sessionId: "webhook-url", label: "Test", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const dependencies = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  Scheduler.layer,
  ServerSettings.layerTest(),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({ list: () => Effect.succeed([]) }),
  Layer.mock(ProjectService.ProjectService)({
    getById: () =>
      Effect.succeed(
        Option.some({
          id: projectId,
          title: "Webhooks",
          workspaceRoot: "/workspace",
          defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          scripts: [],
          createdAt: "2026-10-15T00:00:00.000Z",
          updatedAt: "2026-10-15T00:00:00.000Z",
          deletedAt: null,
        }),
      ),
  }),
);

it.effect.each([
  undefined,
  "https://central.example",
  "https://central.example/t3",
  "https://central.example/t3/",
])("returns canonical webhook URLs through MCP and preserves them after restart: %s", (base) =>
  Effect.gen(function* () {
    const publicUrl = base === undefined ? undefined : decodePublicUrl(base);
    const services = OrchestratorMcpService.layer.pipe(
      Layer.provideMerge(ScheduledTaskService.layer),
      Layer.provide(dependencies),
      Layer.provide(Layer.succeed(PublicAddress.PublicAddress, publicUrl ?? null)),
    );
    const created = yield* Effect.scoped(
      Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        const created = yield* mcp.scheduleTask(scope, {
          projectId,
          prompt: "Review {{body.action}}",
          schedule: { type: "webhook", signature: null },
        });
        const tasks = yield* ScheduledTaskService.ScheduledTaskService;
        const stored = (yield* tasks.list()).tasks[0]!;
        assert.equal(
          created.webhookUrl,
          publicUrl === undefined ? undefined : `${publicUrl.href}${stored.webhook!.path.slice(1)}`,
        );
        return created;
      }).pipe(Effect.provide(Layer.fresh(services))),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        const listed = yield* mcp.listScheduledTasks(scope, { projectId });
        assert.equal(listed.tasks[0]?.webhookUrl, created.webhookUrl);
        const updated = yield* mcp.updateScheduledTask(scope, {
          scheduledTaskId: created.scheduledTaskId,
          title: "Renamed",
        });
        assert.equal(updated.webhookUrl, created.webhookUrl);
        for (const access of ["read-only", "approval-required"] as const) {
          const restricted = yield* mcp.listScheduledTasks(
            {
              ...scope,
              client: { sessionId: "restricted", label: "Restricted", access },
            },
            { projectId },
          );
          assert.equal(restricted.tasks[0]?.webhookUrl, undefined);
          if (created.webhookUrl !== undefined) {
            assert.isFalse(JSON.stringify(restricted).includes(created.webhookUrl));
          }
        }
      }).pipe(Effect.provide(Layer.fresh(services))),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
