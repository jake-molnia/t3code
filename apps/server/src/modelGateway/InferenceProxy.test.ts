// @effect-diagnostics nodeBuiltinImport:off -- A real upstream server proves streaming and disconnect propagation.
import * as NodeHttp from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { HttpRouter } from "effect/http";
import * as InferenceProxy from "./InferenceProxy.ts";

let server: ReturnType<typeof NodeHttp.createServer>;
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;
let requests: Array<{ path: string; authorization: string | undefined; body: string }>;
let upstreamClosed: Promise<void>;
let closeUpstream: () => void;

beforeEach(async () => {
  requests = [];
  upstreamClosed = new Promise<void>((resolve) => {
    closeUpstream = resolve;
  });
  server = NodeHttp.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url ?? "", authorization: request.headers.authorization, body });
    if (request.url?.includes("stream=true")) {
      response.on("close", () => closeUpstream());
      response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "stream-id" });
      response.write('data: {"text":"first"}\n\n');
      return;
    }
    response.writeHead(request.url?.includes("error=true") ? 429 : 200, {
      "content-type": "application/json",
      "retry-after": "3",
      "set-cookie": "private=secret",
    });
    response.end(JSON.stringify({ data: [{ id: "model" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  ({ handler, dispose } = HttpRouter.toWebHandler(
    InferenceProxy.layerWithConfiguration({
      url: `http://127.0.0.1:${address.port}`,
      apiKey: "worker-key",
    }),
    { disableLogger: true },
  ));
});

afterEach(async () => {
  await dispose();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const invoke = (path: string, init?: RequestInit) =>
  handler(new Request(`http://t3.example/api/model-gateway${path}`, init));

describe("model gateway inference boundary", () => {
  it("requires the worker key and never exposes management or arbitrary paths", async () => {
    expect((await invoke("/v1/models")).status).toBe(401);
    expect(
      (await invoke("/v1/models", { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    for (const path of ["/v8/management/config", "/v1/models/private", "/v1/responses"]) {
      expect((await invoke(path, { headers: { authorization: "Bearer worker-key" } })).status).toBe(
        404,
      );
    }
    expect(requests).toEqual([]);
  });

  it("accepts bearer and Anthropic keys and forwards only inference requests", async () => {
    const models = await invoke("/v1/models", { headers: { authorization: "Bearer worker-key" } });
    expect(await models.json()).toEqual({ data: [{ id: "model" }] });
    const response = await invoke("/v1/messages?error=true", {
      method: "POST",
      headers: {
        "x-api-key": "worker-key",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: '{"model":"model"}',
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(response.headers.get("set-cookie")).toBeNull();
    await response.text();
    expect(requests).toEqual([
      { path: "/v1/models", authorization: "Bearer worker-key", body: "" },
      {
        path: "/v1/messages?error=true",
        authorization: "Bearer worker-key",
        body: '{"model":"model"}',
      },
    ]);
  });

  it("streams the first event before upstream completes and cancels on disconnect", async () => {
    const response = await invoke("/v1/responses?stream=true", {
      method: "POST",
      headers: { authorization: "Bearer worker-key", "content-type": "application/json" },
      body: '{"stream":true}',
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-request-id")).toBe("stream-id");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing streaming response");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"first"');
    await reader.cancel();
    await upstreamClosed;
  });
});
