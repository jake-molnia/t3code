import { it, expect } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { resolvePreviewStreamAccess, withPreviewStreamQuery } from "./previewStreamAccess.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("preview-environment"),
  label: "Preview environment",
  httpBaseUrl: "https://t3.example.test",
  wsBaseUrl: "wss://t3.example.test",
});
const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  target,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: `${target.wsBaseUrl}/ws`,
  httpAuthorization: null,
};

it.effect("uses same-origin cookies for browser preview without requesting a ticket", () =>
  Effect.gen(function* () {
    const access = yield* resolvePreviewStreamAccess({
      prepared,
      streamBasePath: "/api/preview-stream",
    }).pipe(
      Effect.provide(
        layerRemoteHttpClient(async () => {
          throw new Error("Cookie preview must not request a ticket.");
        }),
      ),
    );
    expect(access).toEqual({
      httpBase: "https://t3.example.test/api/preview-stream",
      wsBase: "wss://t3.example.test/api/preview-stream",
      query: {},
      credentials: true,
    });
  }),
);

it.effect("mints fresh bearer tickets for preview reconnects without exposing the bearer", () =>
  Effect.gen(function* () {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const http = layerRemoteHttpClient(async (url, init) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({
        ticket: `ticket-${requests.length}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    });
    const resolve = resolvePreviewStreamAccess({
      prepared: { ...prepared, httpAuthorization: { _tag: "Bearer", token: "preview-bearer" } },
      streamBasePath: "/api/preview-stream",
    });
    const first = yield* resolve.pipe(Effect.provide(http));
    const second = yield* resolve.pipe(Effect.provide(http));
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.authorization).toBe("Bearer preview-bearer");
      expect(request.url).toBe("https://t3.example.test/api/auth/websocket-ticket");
    }
    expect(first.query).toEqual({ wsTicket: "ticket-1" });
    expect(second.query).toEqual({ wsTicket: "ticket-2" });
    expect(second.credentials).toBe(false);
    expect(withPreviewStreamQuery(`${second.wsBase}/ws?tabId=tab`, second)).toBe(
      "wss://t3.example.test/api/preview-stream/ws?tabId=tab&wsTicket=ticket-2",
    );
  }),
);
