import { IdeSetup } from "./IdeSetup.ts";
import {
  SandboxIdeError,
  type SandboxIdeOpenInput,
  type SandboxIdeOpenResult,
  type SandboxIdeTarget,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import type { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import { sameIdentity } from "../execution/ExecutionWorker.ts";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";
import { acquireWorkspaceActivity } from "./WorkspaceActivity.ts";
import * as RuntimeClient from "./RuntimeClient.ts";

const encodeWorkspacePayload = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Tuple([Schema.String, Schema.String]))),
);

const sessionLifetime = 12 * 60 * 60 * 1000;
const ticketLifetime = 60 * 1000;
export const routePrefix = "/api/sandbox-ide/";
export const cookieName = "t3_ide_session";

type Session = {
  target: SandboxIdeTarget;
  identity: ExecutionIdentity;
  expiresAt: number;
  ticketExpiresAt: number;
  ticket: string | null;
  cookie: string;
  path: string;
  file: string | undefined;
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
    const preferences = yield* IdeSetup;
    const runtime = yield* RuntimeClient.RuntimeClient;
    const crypto = yield* Crypto.Crypto;
    const serviceScope = yield* Effect.scope;
    const sessions = new Map<string, Session>();
    return SandboxIde.of({
      open: (input) =>
        Effect.gen(function* () {
          const activity = yield* Scope.fork(serviceScope);
          return yield* Effect.gen(function* () {
            const target = input.target;
            yield* preferences.opening(target);
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
            yield* preferences.prepare(client);
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
              target: input.target,
              identity: client.identity,
              expiresAt: now + sessionLifetime,
              ticketExpiresAt: now + ticketLifetime,
              ticket,
              cookie,
              path,
              file: input.file,
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
          const current = yield* (
            "threadId" in session.target
              ? runtime.observeThread(session.target.threadId)
              : runtime.observeWorkspace(`t3:utility:project:${session.target.projectId}`)
          ).pipe(Effect.mapError((cause) => new SandboxIdeError({ reason: "unavailable", cause })));
          if (
            current.kind !== "running" ||
            !sameIdentity(current.client.identity, session.identity)
          ) {
            sessions.delete(input.sessionId);
            return yield* new SandboxIdeError({ reason: "identity_changed" });
          }
          if (input.ticket !== undefined) {
            let path = session.path;
            if (session.file) {
              // code-server uses VS Code's workspace payload for file/line navigation.
              // Its remote authority is the browser host, never the worker endpoint.
              const file = new URL(`vscode-remote://${new URL(input.requestOrigin).host}`);
              file.pathname = session.file.split("/").map(encodeURIComponent).join("/");
              const payload = new URLSearchParams({
                payload: encodeWorkspacePayload([
                  ["openFile", file.toString()],
                  ["gotoLineMode", "true"],
                ]),
              });
              path += `&${payload}`;
            }
            return {
              kind: "bootstrap",
              cookie: session.cookie,
              url: path,
              secure: input.requestOrigin.startsWith("https://"),
            };
          }
          return {
            kind: "proxy",
            access: current.client.credentialSource(),
            connected: Scope.close(session.activity, Exit.void),
          };
        }),
    });
  }),
);
