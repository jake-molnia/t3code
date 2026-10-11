import {
  SandboxIdeError,
  type SandboxIdeOpenInput,
  type SandboxIdeOpenResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import type { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import { sameIdentity } from "../execution/ExecutionWorker.ts";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";
import * as RuntimeClient from "./RuntimeClient.ts";

const sessionLifetime = 12 * 60 * 60 * 1000;
const ticketLifetime = 60 * 1000;
export const routePrefix = "/api/sandbox-ide/";
export const cookieName = "t3_ide_session";

type Session = {
  threadId: ThreadId;
  identity: ExecutionIdentity;
  expiresAt: number;
  ticketExpiresAt: number;
  ticket: string | null;
  cookie: string;
  path: string;
  // Paths scope sessions, not browser trust: IDE content shares the central app origin.
  origin: string | null;
  activity: Scope.Closeable;
};
type Authorization =
  | { kind: "bootstrap"; cookie: string; url: string; secure: boolean }
  | {
      kind: "proxy";
      access: ReturnType<ExecutionClient["credentialSource"]>;
      connected: Effect.Effect<void>;
    };

export class SandboxIde extends Context.Service<
  SandboxIde,
  {
    readonly open: (
      input: SandboxIdeOpenInput,
    ) => Effect.Effect<SandboxIdeOpenResult, SandboxIdeError>;
    readonly authorize: (input: {
      sessionId: string;
      requestOrigin: string;
      origin?: string;
      ticket?: string;
      cookie?: string;
    }) => Effect.Effect<Authorization, SandboxIdeError>;
  }
>()("t3/agentRuntime/SandboxIde") {}

export const layer = Layer.effect(
  SandboxIde,
  Effect.gen(function* () {
    const runtime = yield* RuntimeClient.RuntimeClient;
    const crypto = yield* Crypto.Crypto;
    const serviceScope = yield* Effect.scope;
    const sessions = new Map<string, Session>();
    return SandboxIde.of({
      open: (input) =>
        Effect.gen(function* () {
          const activity = yield* Scope.fork(serviceScope);
          return yield* Effect.gen(function* () {
            const client = yield* runtime
              .forThread(input.threadId, undefined, activity)
              .pipe(
                Effect.mapError((cause) => new SandboxIdeError({ reason: "unavailable", cause })),
              );
            const id = yield* crypto.randomUUIDv4.pipe(
              Effect.mapError((cause) => new SandboxIdeError({ reason: "unavailable", cause })),
            );
            const ticket = yield* crypto.randomUUIDv4.pipe(
              Effect.mapError((cause) => new SandboxIdeError({ reason: "unavailable", cause })),
            );
            const query = new URLSearchParams({ folder: input.cwd });
            const path = `${routePrefix}${id}/?${query}`;
            const cookie = yield* crypto.randomUUIDv4.pipe(
              Effect.mapError((cause) => new SandboxIdeError({ reason: "unavailable", cause })),
            );
            const now = yield* Clock.currentTimeMillis;
            for (const [key, session] of sessions)
              if (session.expiresAt <= now) sessions.delete(key);
            yield* Effect.sleep("60 seconds").pipe(
              Effect.andThen(Scope.close(activity, Exit.void)),
              Effect.forkIn(serviceScope),
            );
            sessions.set(id, {
              activity,
              threadId: input.threadId,
              identity: client.identity,
              expiresAt: now + sessionLifetime,
              ticketExpiresAt: now + ticketLifetime,
              ticket,
              cookie,
              path,
              origin: null,
            });
            return { url: `${path}&ticket=${encodeURIComponent(ticket)}` };
          }).pipe(Effect.onError(() => Scope.close(activity, Exit.void)));
        }),
      authorize: (input) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const session = sessions.get(input.sessionId);
          if (!session || session.expiresAt <= now) {
            sessions.delete(input.sessionId);
            return yield* new SandboxIdeError({ reason: "expired" });
          }
          if (
            (session.origin !== null && input.requestOrigin !== session.origin) ||
            (input.origin !== undefined && input.origin !== input.requestOrigin)
          ) {
            return yield* new SandboxIdeError({ reason: "forbidden" });
          }
          if (input.ticket !== undefined) {
            if (input.ticket !== session.ticket || now >= session.ticketExpiresAt) {
              return yield* new SandboxIdeError({ reason: "forbidden" });
            }
            session.ticket = null;
            session.origin = input.requestOrigin;
          } else if (input.cookie !== session.cookie) {
            return yield* new SandboxIdeError({ reason: "forbidden" });
          }
          const current = yield* runtime
            .observeThread(session.threadId)
            .pipe(
              Effect.mapError((cause) => new SandboxIdeError({ reason: "unavailable", cause })),
            );
          if (
            current.kind !== "running" ||
            !sameIdentity(current.client.identity, session.identity)
          ) {
            sessions.delete(input.sessionId);
            return yield* new SandboxIdeError({ reason: "identity_changed" });
          }
          if (input.ticket !== undefined)
            return {
              kind: "bootstrap",
              cookie: session.cookie,
              url: session.path,
              secure: input.requestOrigin.startsWith("https://"),
            };
          return {
            kind: "proxy",
            access: current.client.credentialSource(),
            connected: Scope.close(session.activity, Exit.void),
          };
        }),
    });
  }),
);
