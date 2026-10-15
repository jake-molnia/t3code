import type { ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { resolveAntigravityInstanceDirectories } from "./antigravityAuthSupport.ts";

const Token = Schema.String.check(Schema.isMaxLength(64 * 1024));
export const ExecutionCredentials = Schema.NullOr(
  Schema.Struct({
    personal: Schema.NullOr(Token),
    business: Schema.NullOr(Token),
  }),
);
type ExecutionCredentials = typeof ExecutionCredentials.Type;

/** Only native OAuth files cross workers; conversations, hooks and MCP configuration do not. */
export const make = Effect.fn("AntigravityCredentials.make")(function* (
  instanceId: ProviderInstanceId,
) {
  const host = yield* ProviderHost.ProviderHost;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directories = yield* resolveAntigravityInstanceDirectories(host.paths.stateDir, instanceId);
  const directory = path.join(directories.profile, "antigravity-acp");
  const files = [
    ["personal", "acp_token.json"],
    ["business", "acp_business_token.json"],
  ] as const;
  const read = Effect.fn("AntigravityCredentials.read")(function* (file: string) {
    return yield* fs.readFileString(path.join(directory, file)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Token)),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
    );
  });
  const load = Effect.gen(function* () {
    const personal = yield* read(files[0][1]);
    const business = yield* read(files[1][1]);
    return personal === null && business === null ? null : { personal, business };
  });
  const save = Effect.fn("AntigravityCredentials.save")(function* (
    credentials: ExecutionCredentials,
  ) {
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    for (const [key, file] of files) {
      const destination = path.join(directory, file);
      const value = credentials?.[key];
      if (value === null || value === undefined) {
        yield* fs.remove(destination, { force: true });
      } else {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const temporary = yield* fs.makeTempDirectoryScoped({
              directory,
              prefix: "credential-",
            });
            const file = path.join(temporary, "token");
            yield* fs.writeFileString(file, value, { mode: 0o600 });
            yield* fs.rename(file, destination);
          }),
        );
      }
    }
  });
  return { load, save };
});
