import type { PrimaryConnectionRegistration } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type { PrimaryEnvironmentTarget } from "../environments/primary/target";

/** Retains a discovered endpoint only while the current primary URLs still match it. */
export function makePrimaryConnectionDiscovery<E, R>(input: {
  readonly readTarget: () => PrimaryEnvironmentTarget | null;
  readonly load: (
    target: PrimaryEnvironmentTarget,
  ) => Effect.Effect<PrimaryConnectionRegistration, E, R>;
}) {
  return Effect.gen(function* () {
    const cached = yield* Ref.make<PrimaryConnectionRegistration | null>(null);
    return Effect.gen(function* () {
      const previous = yield* Ref.get(cached);
      const target = yield* Effect.try(input.readTarget).pipe(Effect.option);
      if (Option.isNone(target)) return previous ? [previous] : [];
      if (target.value === null) {
        yield* Ref.set(cached, null);
        return [];
      }
      const { httpBaseUrl, wsBaseUrl } = target.value.target;
      if (previous?.target.httpBaseUrl === httpBaseUrl && previous.target.wsBaseUrl === wsBaseUrl) {
        return [previous];
      }
      // A replacement endpoint must authenticate itself before it can own the connection.
      yield* Ref.set(cached, null);
      const registration = yield* input.load(target.value).pipe(Effect.option);
      if (Option.isNone(registration)) return [];
      yield* Ref.set(cached, registration.value);
      return [registration.value];
    });
  });
}
