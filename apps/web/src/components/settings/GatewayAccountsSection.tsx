import { useAtomValue } from "@effect/atom-react";
import { ModelGatewayError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type {
  EnvironmentId,
  GatewayAccount,
  GatewayAuth,
  GatewayProvider,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CheckIcon, CopyIcon, KeyRoundIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SecretInput } from "./SecretInput";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const PROVIDERS = [
  { id: "codex", label: "ChatGPT" },
  { id: "claude", label: "Claude" },
  { id: "antigravity", label: "Google Antigravity" },
  { id: "kimi", label: "Kimi Code" },
  { id: "kimi-ai", label: "Kimi" },
  { id: "xai", label: "xAI" },
  { id: "meta", label: "Meta" },
  { id: "devin", label: "Devin" },
  { id: "endpoint", label: "API endpoint" },
] satisfies ReadonlyArray<{ id: GatewayProvider | "endpoint"; label: string }>;

const isGatewayError = Schema.is(ModelGatewayError);
const commandOptions = { reportFailure: false, reportDefect: false };
const failureMessage = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The request failed. Try again.";
};

/** Accounts belong to the environment; every harness uses the same connected accounts. */
export function GatewayAccountsSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const allowed = useAtomValue(serverEnvironment.modelGatewayStart.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    allowed ? serverEnvironment.modelGatewaySnapshot({ environmentId, input: undefined }) : null,
  );
  const enable = useAtomCommand(serverEnvironment.modelGatewaySetEnabled, commandOptions);
  const remove = useAtomCommand(serverEnvironment.modelGatewayRemove, commandOptions);
  const [adding, setAdding] = useState<GatewayProvider | "endpoint" | null>(null);
  const [removing, setRemoving] = useState<GatewayAccount | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshot = query.data;
  const accounts = snapshot?.kind === "ready" ? snapshot.accounts : [];

  async function mutate(account: GatewayAccount, action: "remove" | "toggle") {
    if (pending || !allowed) return;
    setPending(true);
    setError(null);
    const result =
      action === "remove"
        ? await remove({ environmentId, input: { accountId: account.id } })
        : await enable({
            environmentId,
            input: { accountId: account.id, enabled: account.disabled },
          });
    setPending(false);
    if (result._tag === "Success") {
      setRemoving(null);
      query.refresh();
    } else if (!isAtomCommandInterrupted(result)) setError(failureMessage(result));
  }

  return (
    <SettingsSection
      title="Accounts"
      variant="plain"
      headerAction={
        <Button
          size="sm"
          disabled={!allowed || snapshot?.kind !== "ready"}
          onClick={() => setAdding("codex")}
        >
          <PlusIcon />
          Add account
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">
        Connect once, then use your models with any compatible harness.
      </p>
      {allowed && snapshot?.kind === "ready" && snapshot.catalog.kind === "unavailable" ? (
        <SettingsRow
          title="Models are unavailable"
          description="Your accounts are saved, but their models could not be loaded. You can still manage your accounts."
          control={
            <Button size="sm" variant="outline" onClick={query.refresh} disabled={query.isPending}>
              Retry model discovery
            </Button>
          }
        />
      ) : null}
      <SettingsGroup>
        {!allowed ? (
          <SettingsRow
            title="Account management is restricted"
            description="This connection needs permission to manage providers."
          />
        ) : query.error || snapshot?.kind === "unavailable" || snapshot?.kind === "unconfigured" ? (
          <SettingsRow
            title="Accounts are unavailable"
            description="The account service could not be reached. Your saved accounts have not been changed."
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={query.refresh}
                disabled={query.isPending}
              >
                Retry
              </Button>
            }
          />
        ) : !snapshot ? (
          <SettingsRow title="Loading accounts…" />
        ) : accounts.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
            <KeyRoundIcon className="size-6 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Your models start here</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Add an account to make its models available to your agents.
              </p>
            </div>
            <Button size="sm" onClick={() => setAdding("codex")}>
              Connect your first account
            </Button>
          </div>
        ) : (
          accounts.map((account) => (
            <SettingsRow
              key={account.id}
              title={account.label}
              description={
                PROVIDERS.find((provider) => provider.id === account.provider)?.label ??
                (account.provider === "openai-compatible" ? "API endpoint" : account.provider)
              }
              status={account.message ?? undefined}
              control={
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={
                      account.disabled
                        ? "secondary"
                        : account.status === "ready"
                          ? "success"
                          : "warning"
                    }
                  >
                    {account.disabled
                      ? "Disabled"
                      : account.status === "ready"
                        ? account.provider === "openai-compatible"
                          ? "Configured"
                          : "Connected"
                        : "Needs attention"}
                  </Badge>
                  {account.status === "error" &&
                  PROVIDERS.some((provider) => provider.id === account.provider) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending || !allowed}
                      onClick={() => {
                        const provider = PROVIDERS.find(
                          (candidate) => candidate.id === account.provider,
                        );
                        if (provider) setAdding(provider.id);
                      }}
                    >
                      Reconnect
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending || !allowed}
                    onClick={() => void mutate(account, "toggle")}
                  >
                    {account.disabled ? "Enable" : "Disable"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending || !allowed}
                    onClick={() => {
                      setError(null);
                      setRemoving(account);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              }
            />
          ))
        )}
      </SettingsGroup>
      {error && !removing ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {adding ? (
        <GatewaySignIn
          initialProvider={adding}
          environmentId={environmentId}
          onClose={() => {
            setAdding(null);
            query.refresh();
          }}
        />
      ) : null}
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setRemoving(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Remove account?</DialogTitle>
            <DialogDescription>
              {removing?.label} will no longer supply models to your agents. You can connect it
              again later. Conversation history is kept.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <DialogPanel>
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            </DialogPanel>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending || !allowed || !removing}
              onClick={() => {
                if (removing) void mutate(removing, "remove");
              }}
            >
              {pending ? "Removing…" : "Remove account"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}

function GatewaySignIn({
  initialProvider,
  environmentId,
  onClose,
}: {
  readonly initialProvider: GatewayProvider | "endpoint";
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const addEndpoint = useAtomCommand(serverEnvironment.modelGatewayAddEndpoint, commandOptions);
  const start = useAtomCommand(serverEnvironment.modelGatewayStart, commandOptions);
  const status = useAtomCommand(serverEnvironment.modelGatewayStatus, commandOptions);
  const complete = useAtomCommand(serverEnvironment.modelGatewayComplete, commandOptions);
  const cancel = useAtomCommand(serverEnvironment.modelGatewayCancel, commandOptions);
  const allowed = useAtomValue(serverEnvironment.modelGatewayStart.permissionAtom(environmentId));
  const [provider, setProvider] = useState<GatewayProvider | "endpoint">(initialProvider);
  const [auth, setAuth] = useState<GatewayAuth | null>(null);
  const [endpoint, setEndpoint] = useState({ name: "", baseUrl: "", apiKey: "", models: "" });
  const [endpointSaved, setEndpointSaved] = useState(false);
  const [endpointCatalogUnavailable, setEndpointCatalogUnavailable] = useState(false);
  const connected = endpointSaved || auth?.kind === "succeeded";
  const endpointModels = endpoint.models
    .split(/[\n,]/)
    .map((model) => model.trim())
    .filter(Boolean);
  const canConnect =
    provider !== "endpoint" ||
    (Object.values(endpoint).every((value) => value.trim().length > 0) &&
      endpointModels.length > 0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [callback, setCallback] = useState("");
  const [cancelUnavailable, setCancelUnavailable] = useState(false);
  const flow = useRef<GatewayAuth | null>(null);
  const mounted = useRef(true);
  const waitingId = auth?.kind === "waiting" ? auth.flowId : null;
  const label = PROVIDERS.find((item) => item.id === provider)?.label ?? provider;
  const interaction = auth?.kind === "waiting" ? auth.interaction : null;

  const update = useCallback((next: GatewayAuth) => {
    if (
      flow.current?.flowId === next.flowId &&
      flow.current.kind !== "waiting" &&
      next.kind === "waiting"
    )
      return;
    flow.current = next;
    setAuth(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const current = flow.current;
      if (current?.kind === "waiting")
        void cancel({ environmentId, input: { flowId: current.flowId } });
    };
  }, [cancel, environmentId]);

  useEffect(() => {
    if (!waitingId || !allowed) return;
    const flowId = waitingId;
    let stopped = false;
    let timeout: ReturnType<typeof setTimeout>;
    async function poll() {
      const result = await status({ environmentId, input: { flowId } });
      if (stopped) return;
      if (result._tag === "Success") {
        setError(null);
        update(result.value);
        if (result.value.kind !== "waiting") return;
      } else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        if (isGatewayError(failure) && failure.reason === "invalid-flow") {
          update({ kind: "failed", flowId, reason: "expired" });
          return;
        }
        setError(failureMessage(result));
      }
      timeout = setTimeout(() => void poll(), 2000);
    }
    timeout = setTimeout(() => void poll(), 2000);
    return () => {
      stopped = true;
      clearTimeout(timeout);
    };
  }, [allowed, environmentId, status, update, waitingId]);

  async function begin() {
    if (pending || !allowed) return;
    setPending(true);
    setError(null);
    setCallback("");
    if (provider === "endpoint") {
      const result = await addEndpoint({
        environmentId,
        input: {
          name: endpoint.name.trim(),
          baseUrl: endpoint.baseUrl.trim(),
          apiKey: endpoint.apiKey.trim(),
          models: endpointModels,
        },
      });
      if (!mounted.current) return;
      setPending(false);
      if (result._tag === "Success") {
        setEndpointSaved(true);
        setEndpointCatalogUnavailable(
          result.value.kind !== "ready" || result.value.catalog.kind === "unavailable",
        );
        setEndpoint({ name: "", baseUrl: "", apiKey: "", models: "" });
      } else if (!isAtomCommandInterrupted(result)) setError(failureMessage(result));
      return;
    }
    const result = await start({ environmentId, input: { provider } });
    if (!mounted.current) {
      if (result._tag === "Success" && result.value.kind === "waiting")
        void cancel({ environmentId, input: { flowId: result.value.flowId } });
      return;
    }
    setPending(false);
    if (result._tag === "Success") update(result.value);
    else if (!isAtomCommandInterrupted(result)) setError(failureMessage(result));
  }

  async function close() {
    if (pending) return;
    if (auth?.kind === "waiting" && allowed && !cancelUnavailable) {
      setPending(true);
      const result = await cancel({ environmentId, input: { flowId: auth.flowId } });
      setPending(false);
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        if (isGatewayError(failure) && failure.reason === "invalid-flow") {
          update({ kind: "failed", flowId: auth.flowId, reason: "expired" });
        } else {
          if (!isAtomCommandInterrupted(result)) {
            setCancelUnavailable(true);
            setError(
              "Sign-in could not be cancelled. You can close this dialog and let the sign-in expire.",
            );
          }
          return;
        }
      } else {
        update(result.value);
      }
    }
    onClose();
  }

  async function submitCallback() {
    if (pending || !allowed || !waitingId || !callback.trim()) return;
    setPending(true);
    setError(null);
    const result = await complete({
      environmentId,
      input: { flowId: waitingId, callbackUrl: callback.trim() },
    });
    if (!mounted.current) return;
    setPending(false);
    if (result._tag === "Success") {
      setCallback("");
      update(result.value);
    } else if (!isAtomCommandInterrupted(result)) setError(failureMessage(result));
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogPopup showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>
            {connected
              ? endpointSaved
                ? "API endpoint added"
                : "Account connected"
              : `Connect ${label}`}
          </DialogTitle>
          <DialogDescription>
            {connected
              ? "Select one of its available models to start a conversation."
              : "Sign in with your provider. Your account is shared across your agents."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            {!connected && (!auth || auth.kind === "failed" || auth.kind === "cancelled") ? (
              <div className="grid gap-2">
                <Label htmlFor="gateway-provider">Provider</Label>
                <Select
                  value={provider}
                  onValueChange={(value) => {
                    const item = PROVIDERS.find((candidate) => candidate.id === value);
                    if (item) {
                      setProvider(item.id);
                      flow.current = null;
                      setAuth(null);
                      setError(null);
                      setCallback("");
                    }
                  }}
                  disabled={pending}
                >
                  <SelectTrigger id="gateway-provider">
                    <SelectValue>{label}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {PROVIDERS.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            {provider === "endpoint" && !connected ? (
              <div className="grid gap-3">
                <p className="text-sm text-muted-foreground">
                  Connect an OpenAI-compatible API, such as OpenRouter or your own model server.
                </p>
                <div className="grid gap-1.5">
                  <Label htmlFor="endpoint-name">Name</Label>
                  <Input
                    id="endpoint-name"
                    value={endpoint.name}
                    onChange={(event) => setEndpoint({ ...endpoint, name: event.target.value })}
                    placeholder="My model provider"
                    disabled={pending}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="endpoint-url">API base URL</Label>
                  <Input
                    id="endpoint-url"
                    type="url"
                    value={endpoint.baseUrl}
                    onChange={(event) => setEndpoint({ ...endpoint, baseUrl: event.target.value })}
                    placeholder="https://api.example.com/v1"
                    disabled={pending}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="endpoint-key">API key</Label>
                  <SecretInput
                    id="endpoint-key"
                    value={endpoint.apiKey}
                    onChange={(event) => setEndpoint({ ...endpoint, apiKey: event.target.value })}
                    disabled={pending}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="endpoint-models">Model IDs</Label>
                  <Input
                    id="endpoint-models"
                    value={endpoint.models}
                    onChange={(event) => setEndpoint({ ...endpoint, models: event.target.value })}
                    placeholder="model-one, model-two"
                    disabled={pending}
                  />
                  <p className="text-xs text-muted-foreground">
                    Separate model IDs with commas. Use the exact IDs from your provider.
                  </p>
                </div>
              </div>
            ) : null}
            {connected ? (
              <div className="flex items-center gap-2 text-sm">
                <CheckIcon className="size-5 text-success" />
                {endpointCatalogUnavailable
                  ? "Your account was saved. Model discovery is temporarily unavailable; retry it from Accounts."
                  : "Your account is saved."}
              </div>
            ) : null}
            {interaction?.type === "deviceCode" ? (
              <div className="grid gap-3">
                <p className="text-sm">Open the sign-in page and enter this code.</p>
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-4">
                  <code className="text-xl font-semibold tracking-widest">
                    {interaction.userCode}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Copy sign-in code"
                    onClick={() =>
                      void writeTextToClipboard(interaction.userCode, "Sign-in code").catch(() =>
                        setError("Could not copy the code. Select and copy it manually."),
                      )
                    }
                  >
                    <CopyIcon />
                  </Button>
                </div>
              </div>
            ) : null}
            {interaction?.type === "browser" || interaction?.type === "deviceCode" ? (
              <Button render={<a href={interaction.url} target="_blank" rel="noreferrer" />}>
                Open sign-in page
              </Button>
            ) : null}
            {interaction?.type === "browser" && interaction.acceptsCallback ? (
              <form
                className="grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitCallback();
                }}
              >
                <Label htmlFor="gateway-callback">Return URL</Label>
                <p className="text-sm text-muted-foreground">
                  After signing in, copy the full URL from the page you land on and paste it here.
                  It may show a connection error.
                </p>
                <Input
                  id="gateway-callback"
                  type="url"
                  autoComplete="off"
                  value={callback}
                  onChange={(event) => setCallback(event.target.value)}
                  placeholder="http://localhost:…"
                  disabled={pending}
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={pending || !callback.trim() || !allowed}
                >
                  {pending ? "Checking…" : "Complete sign-in"}
                </Button>
              </form>
            ) : null}
            {!allowed ? (
              <p role="alert" className="text-sm text-destructive">
                This connection no longer has permission to manage accounts.
              </p>
            ) : null}
            {auth?.kind === "waiting" ? (
              <p role="status" className="text-sm text-muted-foreground">
                Waiting for you to finish signing in…
              </p>
            ) : null}
            {auth?.kind === "failed" ? (
              <p role="alert" className="text-sm text-destructive">
                {auth.reason === "expired"
                  ? "This sign-in expired. Start again for a fresh code or link."
                  : auth.reason === "unavailable"
                    ? "The account service is unavailable. Try again when it reconnects."
                    : "Sign-in was not completed. Try again."}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => void close()}>
            {connected ? "Done" : cancelUnavailable ? "Close" : "Cancel"}
          </Button>
          {!connected && (!auth || auth.kind === "failed" || auth.kind === "cancelled") ? (
            <Button disabled={pending || !allowed || !canConnect} onClick={() => void begin()}>
              {pending ? "Starting…" : auth ? "Try again" : "Continue"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
