import {
  SandboxIdeError,
  SandboxIdeOpenInput,
  type SandboxIdeOpenResult,
  AuthSessionId,
  AuthOrchestrationOperateScope,
  SandboxIdeTarget,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import { sameIdentity } from "../execution/ExecutionWorker.ts";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";
import * as RuntimeClient from "./RuntimeClient.ts";
import { acquireWorkspaceActivity } from "./WorkspaceActivity.ts";

const encodeWorkspacePayload = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Tuple([Schema.String, Schema.String]))),
);

const sessionLifetime = 12 * 60 * 60 * 1000;
const ticketLifetime = 60 * 1000;
export const routePrefix = "/api/sandbox-ide/";
export const cookieName = "t3_ide_session";

const Session = Schema.Struct({
  authSessionId: AuthSessionId,
  target: SandboxIdeTarget,
  identity: ExecutionIdentity,
  cookie: Schema.String,
  // Paths scope sessions, not browser trust: IDE content shares the central app origin.
  origin: Schema.String,
});
const sessionJson = Schema.fromJsonString(Session);
const sessionKeyJson = Schema.fromJsonString(
  Schema.Struct({
    owner: Schema.String,
    origin: Schema.String,
    input: Schema.Struct({ target: SandboxIdeTarget, cwd: Schema.String }),
    identity: ExecutionIdentity,
  }),
);
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
      owner: { readonly authSessionId: AuthSessionId; readonly origin: string },
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
    const sql = yield* SqlClient.SqlClient;
    const authSessions = yield* AuthSessions.AuthSessionRepository;
    const activities = new Map<string, Set<Scope.Closeable>>();
    const releaseActivity = (id: string) =>
      Effect.gen(function* () {
        const pending = activities.get(id);
        activities.delete(id);
        if (pending) for (const activity of pending) yield* Scope.close(activity, Exit.void);
      });
    return SandboxIde.of({
      open: (input, owner) =>
        Effect.gen(function* () {
          const activity = yield* Scope.fork(serviceScope);
          return yield* Effect.gen(function* () {
            const target = input.target;
            const client = yield* (
              "threadId" in target
                ? runtime.forThread(target.threadId, undefined, activity)
                : Effect.gen(function* () {
                    const workspaceId = `t3:utility:project:${target.projectId}`;
                    yield* acquireWorkspaceActivity(workspaceId).pipe(
                      Effect.provideService(Scope.Scope, activity),
                    );
                    return yield* runtime.forWorkspace(workspaceId);
                  })
            ).pipe(
              Effect.mapError((cause) => new SandboxIdeError({ reason: "unavailable", cause })),
            );
            const identity = client.identity;
            // Stable URLs let later windows reuse the versioned editor assets. Credentials
            // remain random, and a different client, origin, or worker gets a different path.
            const key = yield* Schema.encodeEffect(sessionKeyJson)({
              owner: owner.authSessionId,
              origin: owner.origin,
              input: { target, cwd: input.cwd },
              identity,
            });
            const id = yield* crypto.digest("SHA-256", new TextEncoder().encode(key)).pipe(
              Effect.map((bytes) =>
                Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
              ),
              Effect.mapError((cause) => new SandboxIdeError({ reason: "unavailable", cause })),
            );
            const ticket = yield* crypto.randomUUIDv4.pipe(
              Effect.mapError((cause) => new SandboxIdeError({ reason: "unavailable", cause })),
            );
            const query = new URLSearchParams({ folder: input.cwd });
            const path = `${routePrefix}${id}/?${query}`;
            let ticketPath = path;
            if (input.file) {
              const file = new URL(`vscode-remote://${new URL(owner.origin).host}`);
              file.pathname = input.file.split("/").map(encodeURIComponent).join("/");
              ticketPath += `&${new URLSearchParams({
                payload: encodeWorkspacePayload([
                  ["openFile", file.toString()],
                  ["gotoLineMode", "true"],
                ]),
              })}`;
            }
            const cookie = yield* crypto.randomUUIDv4.pipe(
              Effect.mapError((cause) => new SandboxIdeError({ reason: "unavailable", cause })),
            );
            const encoded = yield* Schema.encodeEffect(sessionJson)({
              authSessionId: owner.authSessionId,
              target,
              identity,
              cookie,
              origin: owner.origin,
            });
            const now = yield* Clock.currentTimeMillis;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`DELETE FROM agent_runtime_ide_tickets WHERE expires_at <= ${now}`;
                yield* sql`DELETE FROM agent_runtime_ide_sessions WHERE expires_at <= ${now}`;
                yield* sql`INSERT INTO agent_runtime_ide_sessions(session_id, session_json, expires_at)
                VALUES (${id}, ${encoded}, ${now + sessionLifetime})
                ON CONFLICT(session_id) DO UPDATE SET expires_at = excluded.expires_at`;
                yield* sql`INSERT INTO agent_runtime_ide_tickets(ticket, session_id, expires_at, path)
                VALUES (${ticket}, ${id}, ${now + ticketLifetime}, ${ticketPath})`;
              }),
            );
            const pending = activities.get(id) ?? new Set<Scope.Closeable>();
            pending.add(activity);
            activities.set(id, pending);
            yield* Effect.sleep("60 seconds").pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  pending.delete(activity);
                  if (activities.get(id) === pending && pending.size === 0) activities.delete(id);
                  yield* Scope.close(activity, Exit.void);
                }),
              ),
              Effect.forkIn(serviceScope),
            );
            return { url: `${path}&ticket=${encodeURIComponent(ticket)}` };
          }).pipe(
            Effect.catchTags({
              SqlError: (cause) =>
                Effect.fail(new SandboxIdeError({ reason: "unavailable", cause })),
              SchemaError: (cause) =>
                Effect.fail(new SandboxIdeError({ reason: "unavailable", cause })),
            }),
            Effect.onError(() => Scope.close(activity, Exit.void)),
          );
        }),
      authorize: (input) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const [row] = yield* sql<{ sessionJson: string; expiresAt: number }>`
            SELECT session_json AS sessionJson, expires_at AS expiresAt
            FROM agent_runtime_ide_sessions WHERE session_id = ${input.sessionId}`;
          if (!row || row.expiresAt <= now) {
            yield* sql`DELETE FROM agent_runtime_ide_sessions WHERE session_id = ${input.sessionId}
              AND expires_at <= ${now}`;
            yield* releaseActivity(input.sessionId);
            return yield* new SandboxIdeError({ reason: "expired" });
          }
          const session = yield* Schema.decodeEffect(sessionJson)(row.sessionJson);
          if (
            input.requestOrigin !== session.origin ||
            (input.origin !== undefined && input.origin !== input.requestOrigin)
          ) {
            return yield* new SandboxIdeError({ reason: "forbidden" });
          }
          if (input.ticket !== undefined) {
            const tickets = yield* sql`SELECT ticket FROM agent_runtime_ide_tickets
              WHERE session_id = ${input.sessionId} AND ticket = ${input.ticket} AND expires_at > ${now}`;
            if (tickets.length === 0) return yield* new SandboxIdeError({ reason: "forbidden" });
          } else if (input.cookie !== session.cookie) {
            return yield* new SandboxIdeError({ reason: "forbidden" });
          }
          const auth = yield* authSessions
            .getById({ sessionId: session.authSessionId })
            .pipe(
              Effect.mapError((cause) => new SandboxIdeError({ reason: "unavailable", cause })),
            );
          if (
            Option.isNone(auth) ||
            auth.value.revokedAt !== null ||
            auth.value.expiresAt.epochMilliseconds <= now ||
            !auth.value.scopes.includes(AuthOrchestrationOperateScope)
          ) {
            yield* sql`DELETE FROM agent_runtime_ide_sessions WHERE session_id = ${input.sessionId}`;
            yield* releaseActivity(input.sessionId);
            return yield* new SandboxIdeError({ reason: "forbidden" });
          }
          const current = yield* (
            "threadId" in session.target
              ? runtime.observeThread(session.target.threadId)
              : runtime.observeWorkspace(`t3:utility:project:${session.target.projectId}`)
          ).pipe(Effect.mapError((cause) => new SandboxIdeError({ reason: "unavailable", cause })));
          if (
            current.kind !== "running" ||
            !sameIdentity(current.client.identity, session.identity)
          ) {
            yield* sql`DELETE FROM agent_runtime_ide_sessions WHERE session_id = ${input.sessionId}`;
            yield* releaseActivity(input.sessionId);
            return yield* new SandboxIdeError({ reason: "identity_changed" });
          }
          if (input.ticket !== undefined) {
            const [consumed] = yield* sql<{ path: string }>`DELETE FROM agent_runtime_ide_tickets
              WHERE session_id = ${input.sessionId} AND ticket = ${input.ticket}
                AND expires_at > ${yield* Clock.currentTimeMillis}
              RETURNING path`;
            if (!consumed) return yield* new SandboxIdeError({ reason: "forbidden" });
            return {
              kind: "bootstrap",
              cookie: session.cookie,
              url: consumed.path,
              secure: input.requestOrigin.startsWith("https://"),
            } satisfies Authorization;
          }
          // Active WebSockets reauthorize every five seconds; persist renewal at most hourly.
          if (row.expiresAt <= now + sessionLifetime - 60 * 60 * 1000) {
            yield* sql`UPDATE agent_runtime_ide_sessions SET expires_at = ${now + sessionLifetime}
              WHERE session_id = ${input.sessionId} AND expires_at = ${row.expiresAt}`;
          }
          return {
            kind: "proxy",
            access: current.client.credentialSource(),
            connected: releaseActivity(input.sessionId),
          } satisfies Authorization;
        }).pipe(
          Effect.catchTags({
            SqlError: (cause) => Effect.fail(new SandboxIdeError({ reason: "unavailable", cause })),
            SchemaError: (cause) =>
              Effect.fail(new SandboxIdeError({ reason: "unavailable", cause })),
          }),
        ),
    });
  }),
).pipe(Layer.provide(AuthSessions.layer));
