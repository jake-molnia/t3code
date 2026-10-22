// @effect-diagnostics nodeBuiltinImport:off -- Kubernetes HTTP/TLS boundary.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Placement } from "./Configuration.ts";

export class KubernetesError extends Schema.TaggedError<KubernetesError>()("KubernetesError", {
  operation: Schema.String,
  httpStatus: Schema.optionalKey(Schema.Number),
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Kubernetes ${this.operation} failed.`;
  }
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const isKubernetesError = Schema.is(KubernetesError);

export class Kubernetes extends Context.Service<
  Kubernetes,
  {
    readonly request: (
      method: "GET" | "POST" | "PATCH" | "DELETE",
      path: string,
      body?: unknown,
    ) => Effect.Effect<unknown, KubernetesError>;
    readonly available: (placement: Placement) => Effect.Effect<boolean>;
  }
>()("t3/sandbox/Kubernetes") {}

export const paths = (namespace: string) => ({
  sandboxes: `/apis/agents.x-k8s.io/v1beta1/namespaces/${encodeURIComponent(namespace)}/sandboxes`,
  pvcs: `/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims`,
  secrets: `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`,
  pods: `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`,
});

/** Native TLS keeps the cluster CA local to this client; it never changes global trust. */
export const layer = Layer.effect(
  Kubernetes,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const endpoint = yield* Config.String("T3_KUBERNETES_URL").pipe(
      Config.withDefault("https://kubernetes.default.svc"),
    );
    const tokenFile = yield* Config.String("T3_KUBERNETES_TOKEN_FILE").pipe(
      Config.withDefault("/var/run/secrets/kubernetes.io/serviceaccount/token"),
    );
    const caFile = yield* Config.String("T3_KUBERNETES_CA_FILE").pipe(
      Config.withDefault("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"),
    );
    const base = yield* Effect.try(() => new URL(endpoint)).pipe(
      Effect.mapError((cause) => new KubernetesError({ operation: "configuration", cause })),
    );
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      return yield* new KubernetesError({
        operation: "configuration",
        cause: "Invalid Kubernetes endpoint",
      });
    const request: Kubernetes["Service"]["request"] = (method, path, body) =>
      Effect.gen(function* () {
        // Projected service-account tokens rotate while the central process remains alive.
        const token = (yield* fs.readFileString(tokenFile)).trim();
        const ca = base.protocol === "https:" ? yield* fs.readFileString(caFile) : undefined;
        if (!token)
          return yield* new KubernetesError({ operation: method, cause: "Empty Kubernetes token" });
        const payload = body === undefined ? undefined : yield* encodeJson(body);
        return yield* Effect.tryPromise({
          try: (signal) =>
            new Promise<unknown>((resolve, reject) => {
              const transport = base.protocol === "https:" ? NodeHttps : NodeHttp;
              const req = transport.request(
                new URL(path, base),
                {
                  method,
                  ca,
                  signal,
                  headers: {
                    authorization: `Bearer ${token}`,
                    accept: "application/json",
                    ...(payload === undefined
                      ? {}
                      : {
                          "content-type":
                            method === "PATCH" ? "application/json-patch+json" : "application/json",
                          "content-length": Buffer.byteLength(payload),
                        }),
                  },
                },
                (response) => {
                  const chunks: Buffer[] = [];
                  let length = 0;
                  response.on("data", (chunk: Buffer) => {
                    length += chunk.length;
                    if (length > 16 * 1024 * 1024)
                      response.destroy(new Error("Kubernetes response exceeds limit"));
                    else chunks.push(chunk);
                  });
                  response.on("error", reject);
                  response.on("end", () => {
                    const status = response.statusCode ?? 500;
                    if (status < 200 || status >= 300) {
                      reject(
                        new KubernetesError({
                          operation: method,
                          httpStatus: status,
                          cause: "Kubernetes request rejected",
                        }),
                      );
                      return;
                    }
                    try {
                      resolve(length ? decodeJson(Buffer.concat(chunks).toString("utf8")) : null);
                    } catch (cause) {
                      reject(cause);
                    }
                  });
                },
              );
              req.setTimeout(15_000, () => req.destroy(new Error("Kubernetes request timed out")));
              req.on("error", reject);
              req.end(payload);
            }),
          catch: (cause) =>
            isKubernetesError(cause) ? cause : new KubernetesError({ operation: method, cause }),
        });
      }).pipe(
        Effect.mapError((cause) =>
          isKubernetesError(cause) ? cause : new KubernetesError({ operation: method, cause }),
        ),
      );
    return Kubernetes.of({
      request,
      available: (placement) =>
        request("GET", `${paths(placement.namespace).sandboxes}?limit=1`).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
    });
  }),
);
