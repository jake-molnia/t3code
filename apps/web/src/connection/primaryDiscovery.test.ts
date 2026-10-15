import { EnvironmentId } from "@t3tools/contracts";
import {
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { PrimaryEnvironmentTarget } from "../environments/primary/target";
import { makePrimaryConnectionDiscovery } from "./primaryDiscovery";

function endpoint(port: number): PrimaryEnvironmentTarget {
  return {
    source: "window-origin",
    target: {
      httpBaseUrl: `http://localhost:${port}/`,
      wsBaseUrl: `ws://localhost:${port}/`,
    },
  };
}
function registration(target: PrimaryEnvironmentTarget) {
  return new PrimaryConnectionRegistration({
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("central"),
      label: "Central",
      ...target.target,
    }),
  });
}

it.effect("discovers a replacement primary endpoint without refetching unchanged endpoints", () =>
  Effect.gen(function* () {
    let current = endpoint(3000);
    const calls: string[] = [];
    const discover = yield* makePrimaryConnectionDiscovery({
      readTarget: () => current,
      load: (target) =>
        Effect.sync(() => {
          calls.push(target.target.httpBaseUrl);
          return registration(target);
        }),
    });
    expect(yield* discover).toEqual([registration(current)]);
    expect(yield* discover).toEqual([registration(current)]);
    current = endpoint(4000);
    expect(yield* discover).toEqual([registration(current)]);
    expect(calls).toEqual(["http://localhost:3000/", "http://localhost:4000/"]);
    current = { ...current, target: { ...current.target, wsBaseUrl: "ws://localhost:4001/" } };
    expect(yield* discover).toEqual([registration(current)]);
    expect(calls).toHaveLength(3);
  }),
);

it.effect("retries a failed replacement without retaining the old endpoint", () =>
  Effect.gen(function* () {
    let current = endpoint(3000);
    let available = true;
    const discover = yield* makePrimaryConnectionDiscovery({
      readTarget: () => current,
      load: (target) => (available ? Effect.succeed(registration(target)) : Effect.fail("offline")),
    });
    expect(yield* discover).toEqual([registration(current)]);
    current = endpoint(4000);
    available = false;
    expect(yield* discover).toEqual([]);
    expect(yield* discover).toEqual([]);
    available = true;
    expect(yield* discover).toEqual([registration(current)]);
  }),
);

it.effect(
  "retains the known endpoint during an unreadable topology but clears a removed primary",
  () =>
    Effect.gen(function* () {
      let current: PrimaryEnvironmentTarget | null = endpoint(3000);
      let unreadable = false;
      const discover = yield* makePrimaryConnectionDiscovery({
        readTarget: () => {
          if (unreadable) throw new Error("not ready");
          return current;
        },
        load: (target) => Effect.succeed(registration(target)),
      });
      const first = yield* discover;
      unreadable = true;
      expect(yield* discover).toEqual(first);
      unreadable = false;
      current = null;
      expect(yield* discover).toEqual([]);
      current = endpoint(5000);
      expect(yield* discover).toEqual([registration(current)]);
    }),
);
