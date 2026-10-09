import {
  SandboxIdeError,
  type SandboxIdeOpenInput,
  type SandboxIdeOpenResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
  url: URL;
};
type Authorization =
  | { kind: "bootstrap"; cookie: string; url: string; secure: boolean }
  | { kind: "proxy"; access: ReturnType<ExecutionClient["credentialSource"]> };

export class SandboxIde extends Context.Service<
  SandboxIde,
  {
    readonly open: (
      input: SandboxIdeOpenInput,
    ) => Effect.Effect<SandboxIdeOpenResult, SandboxIdeError>;
    readonly authorize: (input: {
      sessionId: string;
      host: string;
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
    const configuredOrigin = yield* Config.option(Config.String("T3CODE_SANDBOX_IDE_ORIGIN"));
    const origin = Option.isSome(configuredOrigin) ? new URL(configuredOrigin.value) : null;
    if (
      origin &&
      (origin.protocol !== "https:" ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash ||
        origin.username ||
        origin.password)
    ) {
      return yield* Effect.die(new Error("T3CODE_SANDBOX_IDE_ORIGIN must be an HTTPS origin"));
    }
    const sessions = new Map<string, Session>();
    return SandboxIde.of({
      open: (input) =>
        Effect.gen(function* () {
          if (!origin) return yield* new SandboxIdeError({ reason: "unavailable" });
          const client = yield* runtime
            .forThread(input.threadId)
            .pipe(
              Effect.mapError((cause) => new SandboxIdeError({ reason: "unavailable", cause })),
            );
          const now = yield* Clock.currentTimeMillis;
          for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
          const id = yield* crypto.randomUUIDv4.pipe(
            Effect.mapError((cause) => new SandboxIdeError({ reason: "unavailable", cause })),
          );
          const ticket = yield* crypto.randomUUIDv4.pipe(
            Effect.mapError((cause) => new SandboxIdeError({ reason: "unavailable", cause })),
          );
          const url = new URL(origin);
          url.hostname = `${id}.${origin.hostname}`;
          url.pathname = `${routePrefix}${id}/`;
          url.searchParams.set("folder", input.cwd);
          const cookie = yield* crypto.randomUUIDv4.pipe(
            Effect.mapError((cause) => new SandboxIdeError({ reason: "unavailable", cause })),
          );
          sessions.set(id, {
            threadId: input.threadId,
            identity: client.identity,
            expiresAt: now + sessionLifetime,
            ticketExpiresAt: now + ticketLifetime,
            ticket,
            cookie,
            url,
          });
          const bootstrapUrl = new URL(url);
          bootstrapUrl.searchParams.set("ticket", ticket);
          return { url: bootstrapUrl.toString() };
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
            input.host !== session.url.host ||
            (input.origin !== undefined && input.origin !== session.url.origin)
          ) {
            return yield* new SandboxIdeError({ reason: "forbidden" });
          }
          if (input.ticket !== undefined) {
            if (input.ticket !== session.ticket || now >= session.ticketExpiresAt) {
              return yield* new SandboxIdeError({ reason: "forbidden" });
            }
            session.ticket = null;
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
              url: session.url.toString(),
              secure: true,
            };
          return { kind: "proxy", access: current.client.credentialSource() };
        }),
    });
  }),
);
