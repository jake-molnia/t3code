import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Credentials from "./AntigravityCredentials.ts";
import { resolveAntigravityInstanceDirectories } from "./antigravityAuthSupport.ts";

const decodeCredentials = Schema.decodeUnknownSync(Credentials.ExecutionCredentials);

it.effect(
  "copies only Google credentials between worker homes and preserves session data on logout",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* ProviderHost.ProviderHost;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "antigravity-credentials-" });
      const instance = ProviderInstanceId.make("google-account");
      const store = (stateDir: string, instanceId = instance) =>
        Credentials.make(instanceId).pipe(
          Effect.provide(
            Layer.succeed(ProviderHost.ProviderHost, {
              ...host,
              paths: {
                cwd: root,
                baseDir: stateDir,
                stateDir,
                providerStatusCacheDir: `${stateDir}/status`,
                attachmentsDir: `${stateDir}/attachments`,
              },
            }),
          ),
        );
      const owner = yield* store(`${root}/owner`);
      const first = yield* store(`${root}/first`);
      const second = yield* store(`${root}/second`);
      const otherAccount = yield* store(`${root}/first`, ProviderInstanceId.make("Google-account"));
      const tokens = {
        personal: '{"refresh_token":"personal-fixture"}',
        business: '{"refresh_token":"business-fixture"}',
      };
      yield* owner.save(tokens);
      yield* first.save(yield* owner.load);
      yield* second.save(yield* owner.load);
      expect(yield* otherAccount.load).toBeNull();
      expect(yield* first.load).toEqual(tokens);
      expect(yield* second.load).toEqual(tokens);
      const profile = (yield* resolveAntigravityInstanceDirectories(`${root}/first`, instance))
        .profile;
      const directory = `${profile}/antigravity-acp`;
      expect((yield* fs.stat(`${directory}/acp_token.json`)).mode & 0o777).toBe(0o600);
      yield* fs.writeFileString(`${directory}/conversation.sqlite`, "session fixture");
      yield* fs.writeFileString(`${directory}/mcp_config.json`, "MCP identity fixture");
      yield* first.save(null);
      expect(yield* first.load).toBeNull();
      expect(yield* fs.readFileString(`${directory}/conversation.sqlite`)).toBe("session fixture");
      expect(yield* fs.readFileString(`${directory}/mcp_config.json`)).toBe("MCP identity fixture");
      expect(yield* second.load).toEqual(tokens);
      const reopened = yield* store(`${root}/owner`);
      expect(yield* reopened.load).toEqual(tokens);
      expect(() =>
        decodeCredentials({
          personal: "x".repeat(65537),
          business: null,
        }),
      ).toThrow();
    }).pipe(
      Effect.scoped,
      Effect.provide(TestProviderHost.layer()),
      Effect.provide(NodeServices.layer),
    ),
);
