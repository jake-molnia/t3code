// @effect-diagnostics nodeBuiltinImport:off -- Node HTTP streaming transport boundary.
import * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";
import * as Schema from "effect/Schema";
import { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import { authorized, sameIdentity } from "./ExecutionWorker.ts";
import { waitForService } from "./ServiceReadiness.ts";

export const workerIdePrefix = "/v1/ide/";
export const ideIdentityHeader = "x-t3-ide-identity";
export type WorkerIdeOptions = {
  url: string;
  token: string;
  identity: ExecutionIdentity;
  acquireLease: () => Promise<(() => void) | undefined>;
};
const decodeIdentity = Schema.decodeUnknownSync(Schema.fromJsonString(ExecutionIdentity));
const decodeHealth = Schema.decodeUnknownSync(
  Schema.Struct({ status: Schema.Literals(["alive", "expired"]) }),
);

/** Only the authenticated worker port can reach the loopback IDE. */
export function createWorkerIdeProxy(options: WorkerIdeOptions) {
  const origin = new URL(options.url);
  if (
    origin.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname)
  ) {
    throw new Error("Sandbox IDE must use loopback HTTP");
  }
  const status = (incoming: NodeHttp.IncomingMessage) => {
    if (
      !authorized(
        typeof incoming.headers.authorization === "string" ? incoming.headers.authorization : null,
        options.token,
      )
    )
      return 401;
    try {
      const identity = decodeIdentity(incoming.headers[ideIdentityHeader]);
      return sameIdentity(identity, options.identity) ? 200 : 409;
    } catch {
      return 409;
    }
  };
  const outgoingRequest = (incoming: NodeHttp.IncomingMessage) => {
    const relative = (incoming.url ?? "").slice(workerIdePrefix.length);
    const target = new URL(origin);
    target.pathname = `/${relative.split("?")[0] ?? ""}`;
    target.search = relative.includes("?") ? relative.slice(relative.indexOf("?")) : "";
    const headers = { ...incoming.headers };
    delete headers.authorization;
    delete headers.cookie;
    delete headers[ideIdentityHeader];
    delete headers["x-t3-ide-base"];
    headers.host = incoming.headers["x-forwarded-host"]?.toString() ?? origin.host;
    return NodeHttp.request(target, { method: incoming.method, headers });
  };
  const acquireLease = async (downstream: NodeHttp.ServerResponse | NodeStream.Duplex) => {
    const lease = await options.acquireLease();
    if (!lease) return undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      lease();
    };
    if (downstream.destroyed) {
      release();
      return undefined;
    }
    downstream.once("close", release);
    return release;
  };
  let ready = false;
  const waitUntilReady = async (downstream: NodeHttp.ServerResponse | NodeStream.Duplex) => {
    if (ready) return;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    downstream.once("close", cancel);
    if (downstream.destroyed) cancel();
    try {
      await waitForService(new URL("/healthz", origin), {
        signal: abort.signal,
        accept: async (response) => {
          decodeHealth(await response.json());
          return true;
        },
      });
      ready = true;
    } finally {
      downstream.off("close", cancel);
    }
  };
  return {
    matches: (path: string) => path.startsWith(workerIdePrefix),
    async request(incoming: NodeHttp.IncomingMessage, outgoing: NodeHttp.ServerResponse) {
      const code = status(incoming);
      if (code !== 200) {
        outgoing.writeHead(code).end();
        return;
      }
      const release = await acquireLease(outgoing);
      if (!release) {
        if (!outgoing.destroyed) outgoing.writeHead(409).end();
        return;
      }
      let upstream: NodeHttp.ClientRequest;
      try {
        await waitUntilReady(outgoing);
        if (outgoing.destroyed) return;
        upstream = outgoingRequest(incoming);
      } catch (error) {
        release();
        throw error;
      }

      upstream.on("response", (response) => {
        const headers = { ...response.headers };
        delete headers["set-cookie"];
        const base = incoming.headers["x-t3-ide-base"];
        if (
          typeof headers.location === "string" &&
          headers.location.startsWith("/") &&
          !headers.location.startsWith("//") &&
          typeof base === "string"
        ) {
          headers.location = `${base}${headers.location.slice(1)}`;
        }
        outgoing.writeHead(response.statusCode ?? 502, headers);
        response.on("error", () => outgoing.destroy());
        response.pipe(outgoing);
      });
      upstream.on("error", () => {
        release();
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      outgoing.on("close", () => upstream.destroy());
      incoming.on("error", () => upstream.destroy());
      incoming.pipe(upstream);
    },
    async upgrade(incoming: NodeHttp.IncomingMessage, downstream: NodeStream.Duplex, head: Buffer) {
      const code = status(incoming);
      if (code !== 200) {
        downstream.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\n\r\n`);
        return;
      }
      const release = await acquireLease(downstream);
      if (!release) {
        if (!downstream.destroyed)
          downstream.end("HTTP/1.1 409 Rejected\r\nConnection: close\r\n\r\n");
        return;
      }
      let upstream: NodeHttp.ClientRequest;
      try {
        await waitUntilReady(downstream);
        if (downstream.destroyed) return;
        upstream = outgoingRequest(incoming);
      } catch (error) {
        release();
        throw error;
      }

      upstream.on("upgrade", (response, socket, upstreamHead) => {
        downstream.write(
          `HTTP/1.1 101 Switching Protocols\r\n${response.rawHeaders.reduce((lines, value, index, values) => (index % 2 === 0 ? `${lines}${value}: ${values[index + 1]}\r\n` : lines), "")}\r\n`,
        );
        if (upstreamHead.length) downstream.write(upstreamHead);
        if (head.length) socket.write(head);
        socket.on("error", () => downstream.destroy());
        downstream.on("error", () => socket.destroy());
        socket.on("close", () => downstream.destroy());
        downstream.on("close", () => socket.destroy());
        socket.pipe(downstream).pipe(socket);
      });
      upstream.on("response", (response) => {
        downstream.end(
          `HTTP/1.1 ${response.statusCode ?? 502} Rejected\r\nConnection: close\r\n\r\n`,
        );
        response.resume();
      });
      upstream.on("error", () => {
        release();
        downstream.destroy();
      });
      downstream.on("close", () => upstream.destroy());
      upstream.end();
    },
  };
}
