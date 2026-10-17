// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Fetch transport is consumed outside Effect; request deadlines are cleared after response decoding.
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
  readonly code: "unavailable" | "identity_changed" | "authorization" | "timeout" | "protocol";
  constructor(code: "unavailable" | "identity_changed" | "authorization" | "timeout" | "protocol") {
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
  requestTimeoutMs?: number;
}) {
  const request = options.fetch ?? fetch;
  const endpoint = (path: string) =>
    new URL(path.replace(/^\//, ""), options.endpoint.replace(/\/+$/, "") + "/");
  const headers = { authorization: `Bearer ${options.token}`, "content-type": "application/json" };
  async function exchange<T>(
    path: string,
    init: RequestInit,
    decode: (response: Response) => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    const deadline = new AbortController();
    const duration = options.requestTimeoutMs ?? timeoutMs;
    const timer = duration === undefined ? undefined : setTimeout(() => deadline.abort(), duration);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
    try {
      const response = await request(endpoint(path), { ...init, signal });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new ExecutionTransportError("authorization");
      }
      if (response.status >= 500) {
        await response.body?.cancel();
        throw new ExecutionTransportError("unavailable");
      }
      return await decode(response);
    } catch (error) {
      if (error instanceof ExecutionOperationError || error instanceof ExecutionTransportError)
        throw error;
      if (error instanceof SyntaxError || Schema.isSchemaError(error))
        throw new ExecutionTransportError("protocol");
      throw new ExecutionTransportError(deadline.signal.aborted ? "timeout" : "unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
  async function operationResult(response: Response) {
    const result = decodeExecutionResultSync(await response.json());
    if (!result.ok) throw new ExecutionOperationError(result.code);
    if (!response.ok) throw new ExecutionTransportError("unavailable");
    return result.value;
  }
  async function successfulJSON(response: Response): Promise<unknown> {
    if (!response.ok) {
      await response.body?.cancel();
      throw new ExecutionTransportError("unavailable");
    }
    return response.json();
  }
  return {
    identity: options.identity,
    credentialSource: () => ({
      endpoint: options.endpoint,
      token: options.token,
      identity: options.identity,
    }),
    async transient(method: string, input: unknown, signal?: AbortSignal) {
      return exchange(
        "/v1/transient",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ identity: options.identity, method, input }),
          ...(signal ? { signal } : {}),
        },
        operationResult,
        30_000,
      );
    },
    async ack(sessionId: string, sequence: number) {
      if (sequence === 0) return;
      await exchange(
        "/v1/events/ack",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ identity: options.identity, sessionId, sequence }),
        },
        async (response) => {
          if (!response.ok) throw new ExecutionTransportError("unavailable");
          await response.body?.cancel();
        },
        15_000,
      );
    },
    async operationStatus(operationId: string) {
      return exchange(
        `/v1/operations/${encodeURIComponent(operationId)}`,
        { headers },
        async (response) => decodeStateInputSync(await successfulJSON(response)),
        15_000,
      );
    },
    async inspectIdentity() {
      return exchange(
        "/v1/identity",
        { headers },
        async (response) => decodeExecutionIdentitySync(await successfulJSON(response)),
        15_000,
      );
    },
    async call(
      method: string,
      input: unknown,
      operationId: string = NodeCrypto.randomUUID(),
      signal?: AbortSignal,
    ) {
      return exchange(
        "/v1/operations",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ identity: options.identity, operationId, method, input }),
          ...(signal ? { signal } : {}),
        },
        operationResult,
      );
    },
    async events(after: number, signal?: AbortSignal, sessionId?: string, waitMs = 25000) {
      return exchange(
        `/v1/events?after=${after}${sessionId === undefined ? "" : `&sessionId=${encodeURIComponent(sessionId)}&waitMs=${waitMs}`}`,
        { headers, ...(signal ? { signal } : {}) },
        async (response) => {
          const batch = Schema.decodeUnknownSync(Batch)(await successfulJSON(response));
          if (!sameIdentity(batch.identity, options.identity))
            throw new ExecutionTransportError("identity_changed");
          return batch.events;
        },
        35_000,
      );
    },
  };
}
export type ExecutionClient = ReturnType<typeof createExecutionClient>;
