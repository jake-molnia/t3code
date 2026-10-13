import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import { GitActionScope } from "./RemoteGitDriver.ts";
import * as Crypto from "effect/Crypto";
import { ChildProcessSpawner } from "effect/process";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Routing from "./WorkspaceRouting.ts";
import * as Runtime from "./RuntimeClient.ts";
import * as P from "./worker/GitDriverProtocol.ts";

const encodeProcess = Schema.encodeEffect(P.ProcessRequest);
const decodeProcess = Schema.decodeUnknownEffect(P.vcsResponse(P.ProcessResult));
const isVcsError = Schema.is(C.VcsError);

export const layer = Layer.effect(
  VcsProcess.VcsProcess,
  Effect.gen(function* () {
    const routes = yield* Routing.WorkspaceRouting;
    const runtime = yield* Runtime.RuntimeClient;
    const fs = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    return VcsProcess.VcsProcess.of({
      run: (input) =>
        Effect.gen(function* () {
          const observation = yield* Routing.WorkspaceObservation;
          const scope = yield* GitActionScope;
          const key = `vcs:${input.operation}:${input.cwd}`;
          const ordinal = scope?.counters.get(key) ?? 0;
          scope?.counters.set(key, ordinal + 1);
          const operationId = scope
            ? `${scope.id}:${encodeURIComponent(key)}:${ordinal}`
            : yield* crypto.randomUUIDv4;
          const attachments = [];
          for (const [argumentIndex, arg] of input.args.entries()) {
            const match = /^(.*@)(\/.*\/t3code-pr-body-[^/]+\.md)$/.exec(arg);
            if (match?.[1] && match[2])
              attachments.push({
                argumentIndex,
                prefix: match[1],
                contents: yield* fs.readFileString(match[2]),
              });
          }
          const payload = yield* encodeProcess({
            ...input,
            outputMode: input.outputMode ?? "truncate",
            attachments,
          });
          const raw = P.isSourceControlProbe(input.command, input.args)
            ? yield* Effect.gen(function* () {
                const client = input.cwd.startsWith("/workspace/")
                  ? yield* routes.clientForCwd(input.cwd)
                  : (observation?.client ?? (yield* runtime.forUtility("source-control")));
                const route = input.cwd.startsWith("/workspace/")
                  ? yield* routes.describeCwd(input.cwd)
                  : null;
                const cwd = route
                  ? route.relativeCwd + input.cwd.slice(route.virtualCwd.length)
                  : ".";
                return yield* Effect.tryPromise(() =>
                  client.transient("vcs.process.probe", { ...payload, cwd }),
                );
              })
            : input.cwd.startsWith("/workspace/")
              ? yield* routes
                  .call({
                    cwd: input.cwd,
                    method: "vcs.process",
                    input: payload,
                    operationId,
                  })
                  .pipe(Effect.retry(Schedule.recurs(1)))
              : yield* Effect.gen(function* () {
                  const client =
                    observation?.client ?? (yield* runtime.forUtility("source-control"));
                  return yield* Effect.tryPromise(() =>
                    client.call("vcs.process", { ...payload, cwd: "." }, operationId),
                  ).pipe(Effect.retry(Schedule.recurs(1)));
                });
          const result = yield* decodeProcess(raw);
          if (!result.ok) return yield* result.error;
          if (input.onStdoutChunk)
            input.onStdoutChunk(new TextEncoder().encode(result.value.stdout));
          return { ...result.value, exitCode: ChildProcessSpawner.ExitCode(result.value.exitCode) };
        }).pipe(
          Effect.mapError((cause) =>
            isVcsError(cause)
              ? cause
              : new C.VcsProcessSpawnError({
                  operation: input.operation,
                  command: input.command,
                  cwd: input.cwd,
                  argumentCount: input.args.length,
                  cause,
                }),
          ),
        ),
    });
  }),
);
