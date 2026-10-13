import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { withCodexStartup, codexHomeInitialized } from "./CodexStartup.ts";

it.effect("serializes one home while another home and initialized clients remain independent", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const secondEntered = yield* Deferred.make<void>();
    const first = yield* withCodexStartup(
      "/test/shared-codex",
      {},
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const second = yield* withCodexStartup(
      undefined,
      { CODEX_HOME: "/test/shared-codex" },
      Deferred.succeed(secondEntered, undefined),
    ).pipe(Effect.forkScoped);
    yield* withCodexStartup("/test/other-codex", {}, Effect.void);
    expect(yield* Deferred.isDone(secondEntered)).toBe(false);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    expect(yield* Deferred.isDone(secondEntered)).toBe(true);
    expect(yield* withCodexStartup("/test/shared-codex", {}, Effect.succeed("next client"))).toBe(
      "next client",
    );
  }),
);

it.effect("releases a startup permit after failure and cancellation", () =>
  Effect.gen(function* () {
    yield* withCodexStartup("/test/failing-codex", {}, Effect.fail("failed initialization")).pipe(
      Effect.flip,
    );
    const entered = yield* Deferred.make<void>();
    const first = yield* withCodexStartup(
      "/test/failing-codex",
      {},
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(first);
    expect(yield* codexHomeInitialized("/test/failing-codex", {})).toBe(false);
    expect(yield* withCodexStartup("/test/failing-codex", {}, Effect.succeed("recovered"))).toBe(
      "recovered",
    );
  }),
);
