import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { verifyProviderPins } from "./verify-provider-pins.mjs";

const manifest = {
  harnesses: {
    custom: { kind: "npm", package: "@example/custom", version: "1.2.3" },
    native: {
      kind: "binary",
      version: "2.0.0",
      url: "https://example.test/native",
      sha256: "a".repeat(64),
    },
  },
};
const packageJson = { dependencies: { "@example/custom": "1.2.3" } };
const lockfile = {
  packages: {
    "": packageJson,
    "node_modules/@example/custom": { version: "1.2.3", integrity: "sha512-pinned" },
  },
};

NodeTest.test("accepts additional providers without a driver allowlist", () => {
  verifyProviderPins(manifest, packageJson, lockfile);
});
NodeTest.test("rejects drift, duplicate installations, and missing artifact provenance", () => {
  const mutations = [
    (m) => {
      m.harnesses.custom.version = "latest";
    },
    (m) => {
      m.harnesses.custom.version = "1.2.4";
    },
    (m) => {
      m.harnesses.duplicate = { ...m.harnesses.custom };
    },
    (m) => {
      m.harnesses.native.sha256 = "";
    },
    (m) => {
      m.harnesses.native.url = "http://example.test/native";
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(manifest);
    mutate(changed);
    NodeAssert.throws(() => verifyProviderPins(changed, packageJson, lockfile));
  }
  NodeAssert.throws(() => verifyProviderPins(manifest, { dependencies: {} }, lockfile));
  const missingIntegrity = structuredClone(lockfile);
  delete missingIntegrity.packages["node_modules/@example/custom"].integrity;
  NodeAssert.throws(() => verifyProviderPins(manifest, packageJson, missingIntegrity));
});
