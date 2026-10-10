import * as Schema from "effect/Schema";
import * as C from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as Remote from "./RemoteWorkspaceGitStatus.ts";
import * as Routing from "./WorkspaceRouting.ts";

const status = (refName: string): C.VcsStatusResult => ({
  isRepo: true,
  sourceControlProvider: undefined,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
});

it.effect(
  "explicit Git refresh wakes each workspace after idle; passive streams retain their own snapshots",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const observations: string[] = [];
      let fail = false;
      const routing = Layer.mock(Routing.WorkspaceRouting)({
        enabled: true,
        call: (input) =>
          Effect.gen(function* () {
            calls.push(input.cwd);
            if (fail)
              return yield* new Routing.WorkspaceRoutingError({
                operation: "git.status",
                cause: "worker unavailable",
              });
            return yield* Schema.encodeEffect(Schema.toCodecJson(C.VcsStatusResult))(
              status(input.cwd),
            ).pipe(Effect.orDie);
          }),
        observeCall: (input) =>
          Effect.sync(() => {
            observations.push(input.cwd);
            return null;
          }),
      });
      const service = yield* VcsStatusBroadcaster.VcsStatusBroadcaster.pipe(
        Effect.provide(Remote.layer.pipe(Layer.provide(routing))),
      );
      const first = "/workspace/first/repo";
      const second = "/workspace/second/repo";
      expect((yield* service.refreshStatus(first)).refName).toBe(first);
      expect((yield* service.refreshStatus(second)).refName).toBe(second);
      expect(calls).toEqual([first, second]);
      expect(observations).toEqual([]);
      for (const cwd of [first, second]) {
        const events = yield* service.streamStatus({ cwd }).pipe(Stream.take(1), Stream.runCollect);
        expect(events).toEqual([{ _tag: "snapshot", local: status(cwd), remote: status(cwd) }]);
      }
      expect(calls).toEqual([first, second]);
      expect(observations).toEqual([first, second]);
      fail = true;
      expect((yield* service.refreshStatus(first).pipe(Effect.exit))._tag).toBe("Failure");
    }),
);
