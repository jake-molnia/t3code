import { AuthProvidersManageScope } from "@t3tools/contracts";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import type {
  AcpRegistrySearchAgent,
  EnvironmentId,
  ProviderInstanceConfig,
} from "@t3tools/contracts";
import { ExternalLinkIcon, SearchIcon } from "lucide-react";
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isConfiguredAcpRegistryAgent } from "./AddProviderInstanceDialog.logic";
import { ProviderDriverKind } from "@t3tools/contracts";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";

interface AcpRegistrySearchStepProps {
  readonly environmentId: EnvironmentId;
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly onSelected: (agent: AcpRegistrySearchAgent) => void;
  readonly onManualConfiguration: () => void;
  readonly onLocalConfiguration?: () => void;
  readonly onLoadingChange?: (loading: boolean) => void;
}

export function AcpRegistrySearchStep({
  environmentId,
  providerInstances,
  onSelected,
  onManualConfiguration,
  onLocalConfiguration,
  onLoadingChange,
}: AcpRegistrySearchStepProps) {
  const [query, setQuery] = useState("");
  // An empty registry query is the compact compatible catalog. Start there so
  // entering this step is useful before the user knows what to search for.
  const [submittedQuery, setSubmittedQuery] = useState("");
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const search = useEnvironmentQuery(
    serverEnvironment.searchAcpRegistry({
      environmentId,
      input: { query: submittedQuery },
    }),
  );
  useEffect(
    () => () => {
      if (searchTimer.current !== null) clearTimeout(searchTimer.current);
    },
    [],
  );

  const submitSearch = (nextQuery: string) => {
    if (searchTimer.current !== null) clearTimeout(searchTimer.current);
    const trimmed = nextQuery.trim();
    setQuery(trimmed);
    if (trimmed === submittedQuery) {
      search.refresh();
    } else {
      setSubmittedQuery(trimmed);
    }
  };

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitSearch(query);
  };

  const handleSelect = (agent: AcpRegistrySearchAgent) => {
    if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    onSelected(agent);
  };

  const results = search.data?.agents ?? null;
  const isInitialSearch = search.isPending && results === null;
  const isRefreshing = search.isPending && results !== null;
  const resultCount = results?.length ?? 0;

  useLayoutEffect(() => {
    onLoadingChange?.(search.isPending);
    return () => onLoadingChange?.(false);
  }, [onLoadingChange, search.isPending]);

  return (
    <section className="grid gap-3" aria-labelledby="acp-registry-search-heading">
      <h3 className="sr-only" id="acp-registry-search-heading">
        Choose an agent
      </h3>

      <form className="flex flex-wrap items-center gap-2" onSubmit={handleSearch}>
        <InputGroup className="min-w-40 flex-1">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search ACP Registry"

            onChange={(event) => {
              const nextQuery = event.currentTarget.value;
              setQuery(nextQuery);
              if (searchTimer.current !== null) clearTimeout(searchTimer.current);
              searchTimer.current = setTimeout(() => {
                searchTimer.current = null;
                setSubmittedQuery(nextQuery.trim());
              }, 300);
            }}
            placeholder="Search agents…"
            size="sm"
            type="search"
            value={query}
          />
        </InputGroup>
        <Button onClick={onManualConfiguration} size="sm" type="button" variant="ghost-muted">
          Enter manually
        </Button>
        {onLocalConfiguration ? (
          <Button onClick={onLocalConfiguration} size="sm" type="button" variant="outline">
            Local ACP command
          </Button>
        ) : null}
      </form>

      <div className="sr-only" role="status">
        {isInitialSearch
          ? "Searching the ACP Registry."
          : isRefreshing
            ? "Refreshing ACP Registry results."
            : results
              ? `${resultCount} compatible ${resultCount === 1 ? "agent" : "agents"} found.`
              : ""}
      </div>

      {search.error ? (
        <Alert variant="error" role="status" aria-live="polite">
          <AlertDescription>{search.error}</AlertDescription>
        </Alert>
      ) : null}

      {isInitialSearch ? (
        <div className="flex min-h-20 items-center justify-center text-sm text-muted-foreground">
          Searching the registry...
        </div>
      ) : null}

      {results ? (
        results.length === 0 ? (
          <div className="flex min-h-28 flex-col items-center justify-center rounded-2xl border border-dashed px-4 text-center">
            <p className="text-sm font-medium">No compatible agents found</p>
            <p className="mt-1 text-xs text-muted-foreground">Try a broader search.</p>
          </div>
        ) : (
          <ScrollArea scrollFade className="max-h-64">
            {/* The overlay scrollbar takes no layout space, so the rows
                reserve its lane explicitly. */}
            <div className="pr-2.5">
              {results.map((agent) => {
                const alreadyAdded = isConfiguredAcpRegistryAgent(providerInstances, agent.id);
                return (
                  <article className="min-w-0 py-2.5" key={agent.id}>
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <ProviderInstanceIcon
                          driverKind={ProviderDriverKind.make("acpRegistry")}
                          displayName={agent.name}
                          acpRegistryAgentId={agent.id}
                          acpRegistryIconUrl={agent.icon ?? undefined}
                          iconClassName="size-6 rounded-md text-muted-foreground"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-baseline gap-2">
                            <h4 className="min-w-0 truncate text-sm font-medium text-foreground">
                              {agent.name}
                            </h4>
                          </div>
                          {agent.description ? (
                            <p className="mt-0.5 truncate text-xs text-muted-foreground">
                              {agent.description}
                            </p>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {agent.website || agent.repository ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  size="icon-xs"
                                  variant="ghost-muted"
                                  aria-label={`About ${agent.name}`}
                                  render={
                                    <a
                                      href={agent.website || agent.repository || undefined}
                                      target="_blank"
                                      rel="noreferrer"
                                    />
                                  }
                                >
                                  <ExternalLinkIcon />
                                </Button>
                              }
                            />
                            <TooltipPopup>About {agent.name}</TooltipPopup>
                          </Tooltip>
                        ) : null}
                        <Button
                          aria-label={`${alreadyAdded ? "Already added" : "Add"} ${agent.name}`}
                          disabled={!canManageProviders || alreadyAdded}
                          onClick={() => handleSelect(agent)}
                          size="xs"
                          variant="outline"
                        >
                          {alreadyAdded ? "Added" : "Add"}
                        </Button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </ScrollArea>
        )
      ) : null}
    </section>
  );
}
