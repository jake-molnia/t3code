// @effect-diagnostics nodeBuiltinImport:off -- Normalizes the native subprocess home used as the startup lock key.
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

class StartupGates extends Context.Reference<
  Map<string, { permit: Semaphore.Semaphore; initialized: boolean }>
>("t3/provider/CodexStartup/StartupGates", { defaultValue: () => new Map() }) {}

const homeGate = (homePath: string | undefined, environment: NodeJS.ProcessEnv | undefined) =>
  Effect.gen(function* () {
    const env = { ...(yield* HostProcess.Environment), ...environment };
    const home = env.HOME || (yield* HostProcess.HomeDirectory);
    const configured = homePath || env.CODEX_HOME || NodePath.join(home, ".codex");
    const key = NodePath.resolve(
      configured === "~"
        ? home
        : configured.startsWith("~/")
          ? NodePath.join(home, configured.slice(2))
          : configured,
    );
    const gates = yield* StartupGates;
    let gate = gates.get(key);
    if (!gate) {
      gate = { permit: Semaphore.makeUnsafe(1), initialized: false };
      gates.set(key, gate);
    }
    return gate;
  });

export const codexHomeInitialized = (
  homePath: string | undefined,
  environment: NodeJS.ProcessEnv | undefined,
) => homeGate(homePath, environment).pipe(Effect.map((gate) => gate.initialized));

/** Codex migrates shared SQLite state before initialize; turns run after this permit is released. */
export const withCodexStartup = <A, E, R>(
  homePath: string | undefined,
  environment: NodeJS.ProcessEnv | undefined,
  startup: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const gate = yield* homeGate(homePath, environment);
    return yield* gate.permit.withPermit(
      startup.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            gate.initialized = true;
          }),
        ),
      ),
    );
  });
