import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type * as CodexSchema from "effect-codex-app-server/schema";
import { CodexSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { checkCodexProviderStatus } from "./CodexProvider.ts";

/**
 * Stand-in for Codex 0.162's app-server catalog behavior:
 * - `model/list` answers from `CODEX_HOME/models_cache.json` while it is fresh.
 * - A startup refresh runs before `initialize`, so it uses the originator set
 *   at spawn (the override env var, else the plain CLI's `codex_cli_rs`).
 * - The backend grants Ultrafast only to entitled accounts on app originators.
 */
const FAKE_CODEX_APP_SERVER = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const cachePath = path.join(process.env.CODEX_HOME, "models_cache.json");
const originator = process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? "codex_cli_rs";
const ultrafast = process.env.FAKE_ULTRAFAST_ENTITLED === "1" && originator !== "codex_cli_rs";
const model = (tiers) => ({
  id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", description: "",
  hidden: false, isDefault: true, defaultReasoningEffort: "high",
  supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }],
  serviceTiers: tiers.map((id) => ({ id, name: id, description: "" })),
});
setTimeout(() => {
  const tiers = ultrafast ? ["priority", "ultrafast"] : ["priority"];
  fs.writeFileSync(cachePath, JSON.stringify({ fetched_at: new Date().toISOString(), models: [model(tiers)] }));
}, 300);
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  if (process.env.FAKE_METHODS_PATH) fs.appendFileSync(process.env.FAKE_METHODS_PATH, method + "\n");
  if (method === "initialize") {
    write({ id, result: { userAgent: "codex/0.162.0", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos" } });
  } else if (method === "account/read") {
    write({ id, result: process.env.FAKE_ACCOUNT ? JSON.parse(process.env.FAKE_ACCOUNT) : { account: { type: "chatgpt", email: "test@example.com", planType: "promax" }, requiresOpenaiAuth: false } });
  } else if (method === "account/rateLimits/read") {
    if (JSON.parse(process.env.FAKE_ACCOUNT || "null")?.account?.type === "chatgpt")
      write({ id, result: { rateLimits: { primary: { usedPercent: 12, resetsAt: 1784000000, windowDurationMins: 300 }, secondary: null, credits: null, planType: "plus" } } });
    else write({ id, error: { code: -32600, message: "Subscription quota unavailable" } });
  } else if (method === "skills/list") {
    write({ id, result: { data: [] } });
  } else if (method === "model/list") {
    write({ id, result: { data: JSON.parse(fs.readFileSync(cachePath, "utf8")).models, nextCursor: null } });
  } else {
    write({ id, error: { code: -32601, message: "unsupported" } });
  }
});
`;

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const solServiceTiers = Effect.fn("solServiceTiers")(function* (ultrafastEntitled: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-catalog-" });
  const binaryPath = path.join(dir, "codex");
  yield* fs.writeFileString(binaryPath, FAKE_CODEX_APP_SERVER);
  yield* fs.chmod(binaryPath, 0o755);
  // A fresh cache written by another client: the plain CLI's (no Ultrafast)
  // when entitled, or a stale entitled catalog when the entitlement is gone.
  yield* fs.writeFileString(
    path.join(dir, "models_cache.json"),
    JSON.stringify({
      fetched_at: DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 1 })),
      models: [
        {
          id: "gpt-6.1-sol",
          model: "gpt-6.1-sol",
          displayName: "GPT-6.1 Sol",
          description: "",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }],
          serviceTiers: (ultrafastEntitled ? ["priority"] : ["priority", "ultrafast"]).map(
            (id) => ({ id, name: id, description: "" }),
          ),
        },
      ],
    }),
  );

  const { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: _ambient, ...environment } = process.env;
  const provider = yield* checkCodexProviderStatus(
    decodeCodexSettings({ binaryPath, homePath: dir }),
    undefined,
    { ...environment, FAKE_ULTRAFAST_ENTITLED: ultrafastEntitled ? "1" : "0" },
  );
  const serviceTier = provider.models
    .find((model) => model.slug === "gpt-6.1-sol")
    ?.capabilities?.optionDescriptors?.find((descriptor) => descriptor.id === "serviceTier");
  return serviceTier?.type === "select" ? serviceTier.options.map((option) => option.id) : [];
});

it.layer(NodeServices.layer, { excludeTestServices: true })("Codex catalog discovery", (it) => {
  it.effect.each([
    {
      name: "custom provider",
      account: { account: null, requiresOpenaiAuth: false },
      managed: false,
      unsupported: true,
      calls: 0,
      ready: true,
    },
    {
      name: "API key",
      account: { account: { type: "apiKey" }, requiresOpenaiAuth: false },
      managed: false,
      unsupported: true,
      calls: 0,
      ready: true,
    },
    {
      name: "ChatGPT",
      account: {
        account: { type: "chatgpt", email: "test@example.com", planType: "plus" },
        requiresOpenaiAuth: false,
      },
      managed: false,
      unsupported: false,
      calls: 1,
      ready: true,
    },
    {
      name: "required login",
      account: { account: null, requiresOpenaiAuth: true },
      managed: false,
      unsupported: false,
      calls: 0,
      ready: false,
    },
    {
      name: "managed account",
      account: { account: null, requiresOpenaiAuth: false },
      managed: true,
      unsupported: false,
      calls: 0,
      ready: true,
    },
  ] satisfies ReadonlyArray<{
    name: string;
    account: CodexSchema.V2GetAccountResponse;
    managed: boolean;
    unsupported: boolean;
    calls: number;
    ready: boolean;
  }>)("respects native quota capability for $name", (scenario) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-quota-" });
      const binaryPath = path.join(home, "codex");
      const methodsPath = path.join(home, "methods");
      yield* fs.writeFileString(binaryPath, FAKE_CODEX_APP_SERVER);
      yield* fs.chmod(binaryPath, 0o755);
      yield* fs.writeFileString(
        path.join(home, "models_cache.json"),
        JSON.stringify({ fetched_at: "2020-01-01T00:00:00Z", models: [] }),
      );
      const provider = yield* checkCodexProviderStatus(
        decodeCodexSettings({ binaryPath, homePath: home }),
        undefined,
        {
          ...process.env,
          FAKE_ACCOUNT: JSON.stringify(scenario.account),
          FAKE_METHODS_PATH: methodsPath,
        },
        scenario.managed ? { status: "authenticated", type: "chatgpt" } : undefined,
      );
      const calls = (yield* fs.readFileString(methodsPath)).trim().split("\n");
      assert.strictEqual(
        calls.filter((method) => method === "account/rateLimits/read").length,
        scenario.calls,
      );
      assert.strictEqual(provider.status, scenario.ready ? "ready" : "error");
      if (scenario.unsupported) {
        assert.strictEqual(provider.usageLimits?.unavailable?.reason, "unsupported");
        assert.isUndefined(provider.usageLimits?.unavailable?.message);
      } else if (scenario.calls > 0) {
        assert.isUndefined(provider.usageLimits?.unavailable);
        assert.strictEqual(provider.usageLimits?.windows[0]?.usedPercent, 12);
      } else if (scenario.managed) {
        assert.strictEqual(provider.auth.status, "authenticated");
        assert.isUndefined(provider.usageLimits);
      } else {
        assert.strictEqual(provider.auth.status, "unauthenticated");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("keeps Ultrafast when another Codex client wrote the shared catalog cache", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* solServiceTiers(true), ["default", "priority", "ultrafast"]);
    }).pipe(Effect.scoped),
  );

  it.effect("drops Ultrafast once the account is no longer entitled to it", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* solServiceTiers(false), ["default", "priority"]);
    }).pipe(Effect.scoped),
  );
});
