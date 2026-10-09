import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { expect, it } from "vite-plus/test";
import * as Isolation from "./sandboxIdeIsolation.ts";

const request = (url: string, options?: RequestInit) =>
  new Request(url, {
    ...options,
    headers: { host: new URL(url).host, ...options?.headers },
  });

it("isolates IDE hosts and their browser requests from central application routes", async () => {
  const routes = HttpRouter.add("*", "*", HttpServerResponse.text("allowed")).pipe(
    Layer.provide(Isolation.layer),
    Layer.provide(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          T3CODE_SANDBOX_IDE_ORIGIN: "https://ide.example.com",
        }),
      ),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  try {
    for (const path of ["/", "/ws", "/api/auth/session", "/oauth/authorize"]) {
      expect((await handler(request(`https://session.ide.example.com${path}`))).status).toBe(403);
    }
    expect((await handler(request("https://ide.example.com/"))).status).toBe(403);
    expect((await handler(request("https://t3.example.com/api/sandbox-ide/session/"))).status).toBe(
      403,
    );
    expect(
      (await handler(request("https://session.ide.example.com/api/sandbox-ide/session/"))).status,
    ).toBe(200);
    expect((await handler(request("https://t3.example.com/"))).status).toBe(200);
    for (const method of ["GET", "POST"]) {
      expect(
        (
          await handler(
            request("https://t3.example.com/api/auth/session", {
              method,
              headers: { origin: "https://session.ide.example.com" },
            }),
          )
        ).status,
      ).toBe(403);
    }
    expect((await handler(request("https://notide.example.com/"))).status).toBe(200);
  } finally {
    await dispose();
  }
});
