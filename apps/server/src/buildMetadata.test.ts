import { afterEach, expect, it, vi } from "vite-plus/test";
import { getBuildSourceRevision } from "./buildMetadata.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([undefined, "", "not-a-commit"])(
  "ignores inherited image metadata without a valid embedded revision: %s",
  (embedded) => {
    vi.stubGlobal("__T3CODE_BUILD_SOURCE_REVISION__", embedded);
    vi.stubEnv("T3_SOURCE_REVISION", "b".repeat(40));
    expect(getBuildSourceRevision()).toBeNull();
  },
);

it("keeps the artifact revision when the launching image has a different revision", () => {
  vi.stubGlobal("__T3CODE_BUILD_SOURCE_REVISION__", "a".repeat(40));
  vi.stubEnv("T3_SOURCE_REVISION", "b".repeat(40));
  expect(getBuildSourceRevision()).toBe("a".repeat(40));
});
