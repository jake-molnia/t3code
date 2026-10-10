// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ExecutionPoolId, type ExecutionPoolsSnapshot } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

let snapshot: ExecutionPoolsSnapshot | null = null;
const complete = vi.fn<() => Promise<void>>();
const refresh = vi.fn();
vi.mock("../../hooks/useExecutionPools", () => ({
  useExecutionPools: () => ({ snapshot, failed: false, refresh }),
}));
vi.mock("../../onboarding/firstRun", () => ({ useCompleteOnboarding: () => complete }));

import { ManagedOnboardingGate } from "./ManagedOnboardingGate";

const environmentId = EnvironmentId.make("central");
const poolId = ExecutionPoolId.make("gompers");
const configured: ExecutionPoolsSnapshot = {
  defaultPoolId: poolId,
  pools: [{ id: poolId, label: "Gompers", available: false, resources: null, providerDrivers: [] }],
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  complete.mockResolvedValue(undefined);
  snapshot = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("skips obsolete setup and finishes once only after onboarding persistence succeeds", async () => {
  snapshot = configured;
  let resolve!: () => void;
  complete.mockReturnValue(
    new Promise<void>((done) => {
      resolve = done;
    }),
  );
  const onDone = vi.fn();
  const Legacy = vi.fn(() => <div>Connect your computers</div>);
  await act(async () =>
    root.render(
      <StrictMode>
        <ManagedOnboardingGate environmentId={environmentId} onDone={onDone}>
          <Legacy />
        </ManagedOnboardingGate>
      </StrictMode>,
    ),
  );
  expect(Legacy).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledOnce();
  expect(onDone).not.toHaveBeenCalled();
  await act(async () => resolve());
  expect(onDone).toHaveBeenCalledOnce();
});

it("waits for pool discovery without flashing legacy setup", async () => {
  const onDone = vi.fn();
  const Legacy = vi.fn(() => <div>Install agents</div>);
  const render = () =>
    root.render(
      <ManagedOnboardingGate environmentId={environmentId} onDone={onDone}>
        <Legacy />
      </ManagedOnboardingGate>,
    );
  await act(async () => render());
  expect(Legacy).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  snapshot = configured;
  await act(async () => render());
  expect(onDone).toHaveBeenCalledOnce();
  expect(Legacy).not.toHaveBeenCalled();
});

it("preserves existing setup for a server without configured execution pools", async () => {
  snapshot = { defaultPoolId: poolId, pools: [] };
  await act(async () =>
    root.render(
      <ManagedOnboardingGate environmentId={environmentId} onDone={vi.fn()}>
        <div>Existing setup</div>
      </ManagedOnboardingGate>,
    ),
  );
  expect(container.textContent).toContain("Existing setup");
  expect(complete).not.toHaveBeenCalled();
});

it("allows retry when onboarding state could not be saved", async () => {
  snapshot = configured;
  complete.mockRejectedValueOnce(new Error("storage unavailable"));
  const onDone = vi.fn();
  await act(async () =>
    root.render(
      <ManagedOnboardingGate environmentId={environmentId} onDone={onDone}>
        <div>Old setup</div>
      </ManagedOnboardingGate>,
    ),
  );
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(onDone).not.toHaveBeenCalled();
  await act(async () => container.querySelector("button")!.click());
  expect(onDone).toHaveBeenCalledOnce();
  expect(complete).toHaveBeenCalledTimes(2);
});
