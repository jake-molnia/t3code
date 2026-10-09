// @effect-diagnostics nodeBuiltinImport:off -- Node transport and durable journal boundary, also consumed outside Effect.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import {
  ExecutionIdentity,
  ExecutionEvent,
  ExecutionResult,
} from "../../../../packages/contracts/src/execution.ts";
import { sameIdentity } from "./ExecutionWorker.ts";

const decodeExecutionResultSync = Schema.decodeUnknownSync(ExecutionResult);
const decodeStateInputSync = Schema.decodeUnknownSync(
  Schema.Struct({
    state: Schema.Literals(["missing", "running", "completed", "unknown"]),
    result: Schema.optionalKey(ExecutionResult),
  }),
);
const decodeExecutionIdentitySync = Schema.decodeUnknownSync(ExecutionIdentity);

export class ExecutionOperationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export class ExecutionTransportError extends Error {
  readonly code: "unavailable" | "identity_changed" | "authorization";
  constructor(code: "unavailable" | "identity_changed" | "authorization") {
    super(`Worker transport ${code}`);
    this.code = code;
  }
}

const Batch = Schema.Struct({ identity: ExecutionIdentity, events: Schema.Array(ExecutionEvent) });
export function createExecutionClient(options: {
  endpoint: string;
  token: string;
  identity: ExecutionIdentity;
  fetch?: typeof fetch;
}) {
  const request = options.fetch ?? fetch;
  const endpoint = (path: string) =>
    new URL(path.replace(/^\//, ""), options.endpoint.replace(/\/+$/, "") + "/");
  const headers = { authorization: `Bearer ${options.token}`, "content-type": "application/json" };
  return {
    identity: options.identity,
    credentialSource: () => ({
      endpoint: options.endpoint,
      token: options.token,
      identity: options.identity,
    }),
    async transient(method: string, input: unknown) {
      const response = await request(endpoint("/v1/transient"), {
        method: "POST",
        headers,
        body: JSON.stringify({ identity: options.identity, method, input }),
      });
      if (response.status === 401) throw new Error("Worker authorization rejected");
      const result = decodeExecutionResultSync(await response.json());
      if (!result.ok) throw new ExecutionOperationError(result.code);
      return result.value;
    },
    async ack(sessionId: string, sequence: number) {
      if (sequence === 0) return;
      const response = await request(endpoint("/v1/events/ack"), {
        method: "POST",
        headers,
        body: JSON.stringify({ identity: options.identity, sessionId, sequence }),
      });
      if (!response.ok) throw new Error("Worker replay acknowledgement failed");
    },
    async operationStatus(operationId: string) {
      const response = await request(
        endpoint(`/v1/operations/${encodeURIComponent(operationId)}`),
        { headers },
      );
      if (!response.ok) throw new Error("Worker operation status unavailable");
      return decodeStateInputSync(await response.json());
    },
    async inspectIdentity() {
      const response = await request(endpoint("/v1/identity"), { headers });
      if (!response.ok) throw new Error("Worker identity unavailable");
      return decodeExecutionIdentitySync(await response.json());
    },
    async call(method: string, input: unknown, operationId: string = NodeCrypto.randomUUID()) {
      const response = await request(endpoint("/v1/operations"), {
        method: "POST",
        headers,
        body: JSON.stringify({ identity: options.identity, operationId, method, input }),
      });
      if (response.status === 401) throw new Error("Worker authorization rejected");
      const result = decodeExecutionResultSync(await response.json());
      if (!result.ok) throw new ExecutionOperationError(result.code);
      return result.value;
    },
    async events(after: number, signal?: AbortSignal, sessionId?: string, waitMs = 25000) {
      const response = await request(
        endpoint(
          `/v1/events?after=${after}${sessionId === undefined ? "" : `&sessionId=${encodeURIComponent(sessionId)}&waitMs=${waitMs}`}`,
        ),
        {
          headers,
          ...(signal ? { signal } : {}),
        },
      ).catch(() => {
        throw new ExecutionTransportError("unavailable");
      });
      if (!response.ok)
        throw new ExecutionTransportError(
          response.status === 401 ? "authorization" : "unavailable",
        );
      const batch = Schema.decodeUnknownSync(Batch)(await response.json());
      if (!sameIdentity(batch.identity, options.identity))
        throw new ExecutionTransportError("identity_changed");
      return batch.events;
    },
  };
}
export type ExecutionClient = ReturnType<typeof createExecutionClient>;
