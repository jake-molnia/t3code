import {
  EnvironmentId,
  GatewayFlowId,
  ModelGatewayError,
  type GatewayAuth,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  allowed: true,
  start: vi.fn(),
  status: vi.fn(),
  cancel: vi.fn(),
  complete: vi.fn(),
  add: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    modelGatewayStart: Object.assign(state.start, { permissionAtom: () => "permission" }),
    modelGatewayStatus: state.status,
    modelGatewayCancel: state.cancel,
    modelGatewayComplete: state.complete,
    modelGatewayAddEndpoint: state.add,
    modelGatewaySetEnabled: vi.fn(),
    modelGatewayRemove: vi.fn(),
    modelGatewaySnapshot: vi.fn(),
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { kind: "ready", accounts: [], models: [] },
    refresh: state.refresh,
  }),
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: vi.fn() }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/label", () => ({ Label: "label" }));
vi.mock("../ui/badge", () => ({ Badge: "span" }));
vi.mock("./SecretInput", () => ({ SecretInput: "input" }));
vi.mock("./SettingsGroup", () => ({ SettingsGroup: "div" }));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({
    children,
    headerAction,
  }: {
    children: ReactNode;
    headerAction: ReactNode;
  }) => (
    <section>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({ control }: { control: ReactNode }) => <div>{control}</div>,
}));
vi.mock("../ui/select", () => ({
  Select: "select",
  SelectItem: "option",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "span",
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogPopup: "div",
  DialogHeader: "div",
  DialogTitle: "h2",
  DialogDescription: "p",
  DialogPanel: "div",
  DialogFooter: "footer",
}));

import { GatewayAccountsSection } from "./GatewayAccountsSection";
const environmentId = EnvironmentId.make("test");
const flowId = GatewayFlowId.make("login");
const waiting: GatewayAuth = {
  kind: "waiting",
  flowId,
  provider: "codex",
  expiresAt: "2026-10-14T00:00:00.000Z",
  interaction: { type: "deviceCode", id: flowId, url: "https://login.example", userCode: "CODE" },
};
let renderer: ReactTestRenderer | undefined;
function button(label: string) {
  const result = renderer?.root
    .findAllByType("button")
    .find((item) => item.children.includes(label));
  if (!result) throw new Error(`Button not found: ${label}`);
  return result;
}
async function mountSignIn() {
  await act(async () => {
    renderer = create(<GatewayAccountsSection environmentId={environmentId} />);
  });
  await act(async () => {
    button("Add account").props.onClick();
  });
  await act(async () => {
    button("Continue").props.onClick();
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  state.allowed = true;
  state.start.mockReset().mockResolvedValue(AsyncResult.success(waiting));
  state.status.mockReset().mockResolvedValue(AsyncResult.success(waiting));
  state.cancel.mockReset().mockResolvedValue(AsyncResult.success({ kind: "cancelled", flowId }));
  state.complete.mockReset();
  state.refresh.mockReset();
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("turns a lost server flow into a retryable expiry and stops polling", async () => {
  state.status.mockResolvedValue(
    AsyncResult.failure(Cause.fail(new ModelGatewayError({ reason: "invalid-flow" }))),
  );
  await mountSignIn();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(button("Try again")).toBeDefined();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(state.status).toHaveBeenCalledTimes(1);
  await act(async () => {
    button("Cancel").props.onClick();
  });
  expect(renderer?.root.findAllByType("footer")).toHaveLength(0);
});

it("can close after provider-management permission is revoked", async () => {
  await mountSignIn();
  state.allowed = false;
  await act(async () => {
    renderer?.update(<GatewayAccountsSection environmentId={environmentId} />);
  });
  await act(async () => {
    button("Cancel").props.onClick();
  });
  expect(renderer?.root.findAllByType("footer")).toHaveLength(0);
});

it("can cancel immediately after a server restart before the next poll", async () => {
  state.cancel.mockResolvedValue(
    AsyncResult.failure(Cause.fail(new ModelGatewayError({ reason: "invalid-flow" }))),
  );
  await mountSignIn();
  await act(async () => {
    button("Cancel").props.onClick();
  });
  expect(renderer?.root.findAllByType("footer")).toHaveLength(0);
  expect(state.cancel).toHaveBeenCalledTimes(1);
});

it("allows dismissal when cancellation cannot reach the gateway", async () => {
  state.cancel.mockResolvedValue(
    AsyncResult.failure(Cause.fail(new ModelGatewayError({ reason: "unavailable" }))),
  );
  await mountSignIn();
  await act(async () => {
    button("Cancel").props.onClick();
  });
  expect(button("Close")).toBeDefined();
  await act(async () => {
    button("Close").props.onClick();
  });
  expect(renderer?.root.findAllByType("footer")).toHaveLength(0);
});
