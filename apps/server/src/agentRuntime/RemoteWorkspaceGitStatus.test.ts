import * as GitWorkflowService from "../git/GitWorkflowService.ts";
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
      let failObservation = false;
      const routing = Layer.mock(Routing.WorkspaceRouting)({
        enabled: true,
        observe: (cwd) =>
          Effect.gen(function* () {
            observations.push(cwd);
            if (failObservation)
              return yield* new Routing.WorkspaceRoutingError({
                operation: "observe",
                cause: "worker suspended during read",
              });
            return null;
          }),
      });
      const workflow = Layer.mock(GitWorkflowService.GitWorkflowService)({
        invalidateLocalStatus: () => Effect.void,
        invalidateStatus: () => Effect.void,
        status: (input) =>
          Effect.gen(function* () {
            calls.push(input.cwd);
            if (fail)
              return yield* new C.GitCommandError({
                operation: "status",
                cwd: input.cwd,
                command: "git",
                detail: "worker unavailable",
              });
            return status(input.cwd);
          }),
      });
      const service = yield* VcsStatusBroadcaster.VcsStatusBroadcaster.pipe(
        Effect.provide(Remote.layer.pipe(Layer.provide(Layer.merge(routing, workflow)))),
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
      failObservation = true;
      expect(
        yield* service.streamStatus({ cwd: first }).pipe(Stream.take(1), Stream.runCollect),
      ).toEqual([{ _tag: "snapshot", local: status(first), remote: status(first) }]);
      fail = true;
      expect((yield* service.refreshStatus(first).pipe(Effect.exit))._tag).toBe("Failure");
    }),
);
