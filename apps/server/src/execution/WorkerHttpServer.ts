// @effect-diagnostics nodeBuiltinImport:off -- Standalone Node HTTP application boundary.
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";

/** Bind inside the sandbox. Authentication remains mandatory on every control route. */
export async function listenWorker(options: {
  host: string;
  port: number;
  handle: (request: Request) => Promise<Response>;
  maxBodyBytes?: number;
}) {
  const server = NodeHttp.createServer(async (incoming, outgoing) => {
    const abort = new AbortController();
    outgoing.on("close", () => abort.abort());
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of incoming) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > (options.maxBodyBytes ?? 16 * 1024 * 1024)) {
          outgoing.writeHead(413).end();
          return;
        }
        chunks.push(buffer);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name, value);
        else if (value) for (const item of value) headers.append(name, item);
      }
      const request = new Request(new URL(incoming.url ?? "/", "http://worker"), {
        method: incoming.method ?? "GET",
        headers,
        signal: abort.signal,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await options.handle(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) {
        outgoing.end();
        return;
      }
      const reader = response.body.getReader();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          if (!outgoing.write(part.value))
            await NodeEvents.EventEmitter.once(outgoing, "drain", { signal: abort.signal });
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      outgoing.end();
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    }
  });
  server.listen(options.port, options.host);
  await NodeEvents.EventEmitter.once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Worker listen failed");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
