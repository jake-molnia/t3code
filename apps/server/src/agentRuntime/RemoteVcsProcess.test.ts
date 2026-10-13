import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runtime from "./RuntimeClient.ts";
import * as Routing from "./WorkspaceRouting.ts";
import * as RemoteProcess from "./RemoteVcsProcess.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { createExecutionClient } from "../execution/ExecutionClient.ts";

it.effect(
  "shares pending discovery acquisition, caches only successful versions per worker, and refreshes auth",
  () =>
    Effect.gen(function* () {
      let acquisitions = 0;
      let calls = 0;
      let incarnation = "first";
      let output = "gh version 1";
      let fail = false;
      const runtime = Layer.mock(Runtime.RuntimeClient)({
        enabled: true,
        forUtility: () =>
          Effect.gen(function* () {
            acquisitions++;
            yield* Effect.yieldNow;
            return createExecutionClient({
              endpoint: "http://worker.test",
              token: "test-token",
              identity: {
                workspaceId: "utility",
                allocationId: incarnation,
                incarnation,
                generation: 1,
                podUid: incarnation,
                protocolVersion: 1,
              },
              fetch: async () => {
                calls++;
                return Response.json(
                  fail
                    ? { ok: false, code: "unavailable" }
                    : {
                        ok: true,
                        value: {
                          ok: true,
                          value: {
                            exitCode: 0,
                            stdout: output,
                            stderr: "",
                            stdoutTruncated: false,
                            stderrTruncated: false,
                          },
                        },
                      },
                );
              },
            });
          }),
      });
      yield* Effect.gen(function* () {
        const process = yield* VcsProcess.VcsProcess;
        const probe = (args: readonly string[]) =>
          process.run({
            operation:
              args[0] === "--version"
                ? "source-control.discovery.probe"
                : "source-control.discovery.auth",
            command: "gh",
            args: [...args],
            cwd: "/central",
          });
        const results = yield* Effect.all([probe(["--version"]), probe(["auth", "status"])], {
          concurrency: "unbounded",
        });
        expect(acquisitions).toBe(1);
        expect(calls).toBe(2);
        expect(results[0]?.stdout).toBe("gh version 1");
        output = "changed auth";
        expect((yield* probe(["--version"])).stdout).toBe("gh version 1");
        expect(calls).toBe(2);
        expect((yield* probe(["auth", "status"])).stdout).toBe("changed auth");
        expect(calls).toBe(3);
        expect(acquisitions).toBe(3);
        incarnation = "replacement";
        output = "gh version 2";
        expect((yield* probe(["--version"])).stdout).toBe("gh version 2");
        expect(calls).toBe(4);
        incarnation = "recovering";
        fail = true;
        yield* probe(["--version"]).pipe(Effect.flip);
        fail = false;
        output = "gh version 3";
        expect((yield* probe(["--version"])).stdout).toBe("gh version 3");
        expect(calls).toBe(6);
        const beforeEviction = calls;
        for (let generation = 0; generation < 65; generation++) {
          incarnation = `bounded-${generation}`;
          yield* probe(["--version"]);
        }
        incarnation = "first";
        output = "refreshed after eviction";
        expect((yield* probe(["--version"])).stdout).toBe("refreshed after eviction");
        expect(calls).toBe(beforeEviction + 66);
      }).pipe(
        Effect.provide(
          RemoteProcess.layer.pipe(
            Layer.provide(runtime),
            Layer.provide(Layer.mock(Routing.WorkspaceRouting)({ enabled: true })),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    }),
);
