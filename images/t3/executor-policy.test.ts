import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import {
  createExecutor,
  definePlugin,
  IntegrationSlug,
  ConnectionName,
  AuthTemplateSlug,
  ToolName,
  ToolAddress,
  ProviderKey,
} from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import { toolkitsPlugin } from "./server";
import { createExecutionEngine } from "../../../core/execution/src/engine";
import { makeQuickJsExecutor } from "../../../kernel/runtime-quickjs/src/index";

const integration = IntegrationSlug.make("t3_fixture");
const fixture = Effect.gen(function* () {
  const invoked: string[] = [];
  const credentials = new Map<string, string>();
  let afterInvocation = Effect.void;
  const plugin = definePlugin(() => ({
    id: "t3-probe",
    credentialProviders: [
      {
        key: ProviderKey.make("memory"),
        writable: true,
        get: (key) => Effect.succeed(credentials.get(String(key)) ?? null),
        set: (key, value) =>
          Effect.sync(() => {
            credentials.set(String(key), value);
          }),
      },
    ],
    storage: () => ({}),
    resolveTools: () =>
      Effect.succeed({
        tools: ["read", "write"].map((name) => ({ name: ToolName.make(name), description: name })),
      }),
    describeAuthMethods: () => [{ id: "none", label: "None", kind: "none", template: "none" }],
    invokeTool: ({ toolRow }) =>
      Effect.gen(function* () {
        invoked.push(String(toolRow.name));
        yield* afterInvocation;
        return { ran: toolRow.name };
      }),
    extension: (ctx) => ({
      seed: () =>
        ctx.core.integrations.register({
          slug: integration,
          description: "T3 fixture",
          config: {},
        }),
    }),
  }))();
  const config = makeTestConfig({ plugins: [plugin, toolkitsPlugin()], coreTools: {} });
  const admin = yield* createExecutor(config);
  yield* Effect.addFinalizer(() => Effect.promise(() => config.testDb.close()));
  yield* admin["t3-probe"].seed();
  yield* admin.connections.create({
    owner: "org",
    name: ConnectionName.make("main"),
    integration,
    template: AuthTemplateSlug.make("none"),
    values: {},
  });
  const first = yield* admin.toolkits.create({ owner: "org", name: "First", slug: "first" });
  const second = yield* admin.toolkits.create({ owner: "org", name: "Second", slug: "second" });
  const grant = yield* admin.toolkits.createConnection(first.id, {
    pattern: "t3_fixture.org.main.read",
  });
  yield* admin.toolkits.createConnection(second.id, { pattern: "t3_fixture.org.main.write" });
  const scoped = yield* createExecutor({
    ...config,
    plugins: [plugin, toolkitsPlugin({ activeToolkitSlug: "first" })],
  });
  const scopedOther = yield* createExecutor({
    ...config,
    plugins: [plugin, toolkitsPlugin({ activeToolkitSlug: "second" })],
  });
  const engine = createExecutionEngine({ executor: scoped, codeExecutor: makeQuickJsExecutor() });
  yield* Effect.addFinalizer(() => engine.shutdown);
  const revoke = admin.toolkits.removeConnection(first.id, grant.id);
  return {
    admin,
    scoped,
    scopedOther,
    engine,
    invoked,
    revoke,
    revokeAfterInvocation: () => {
      afterInvocation = revoke;
    },
  };
});

describe("T3 project allowlist probe against pinned Executor", () => {
  it.effect("filters discovery by project and denies direct static/core escalation", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      expect((yield* f.scoped.tools.list()).map((tool) => String(tool.address))).toEqual([
        "tools.t3_fixture.org.main.read",
      ]);
      expect((yield* f.scopedOther.tools.list()).map((tool) => String(tool.address))).toEqual([
        "tools.t3_fixture.org.main.write",
      ]);
      for (const address of [
        "executor.coreTools.policies.create",
        "executor.coreTools.connections.create",
        "executor.coreTools.providers.list",
        "tools.t3_fixture.org.main.write",
      ]) {
        const result = yield* Effect.result(
          f.scoped.execute(ToolAddress.make(address), {
            owner: "org",
            pattern: "*",
            action: "approve",
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure._tag).toBe("ToolBlockedError");
      }
      expect(f.invoked).toEqual([]);
      expect(yield* f.admin.policies.list()).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("QuickJS execute cannot bypass tool selection or mutate core policies", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const outcome = yield* f.engine.executeWithPause(
        `return [await tools.t3_fixture.org.main.read({}), await tools.t3_fixture.org.main.write({}), await tools.executor.coreTools.policies.create({owner:"org",pattern:"*",action:"approve"})];`,
      );
      expect(outcome.status).toBe("completed");
      if (outcome.status !== "completed") return;
      expect(outcome.result.result).toEqual([
        { ok: true, data: { ran: "read" } },
        { ok: false, error: expect.objectContaining({ code: "tool_blocked" }) },
        { ok: false, error: expect.objectContaining({ code: "tool_blocked" }) },
      ]);
      expect(f.invoked).toEqual(["read"]);
      expect(yield* f.admin.policies.list()).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "revocation between two calls in one QuickJS execution blocks the second side effect",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.revokeAfterInvocation();
        const outcome = yield* f.engine.executeWithPause(
          `return [await tools.t3_fixture.org.main.read({}), await tools.t3_fixture.org.main.read({})];`,
        );
        expect(outcome.status).toBe("completed");
        if (outcome.status !== "completed") return;
        expect(outcome.result.result).toEqual([
          { ok: true, data: { ran: "read" } },
          { ok: false, error: expect.objectContaining({ code: "tool_blocked" }) },
        ]);
        expect(f.invoked).toEqual(["read"]);
        expect(yield* f.scoped.tools.list()).toEqual([]);
      }).pipe(Effect.scoped),
  );
});
