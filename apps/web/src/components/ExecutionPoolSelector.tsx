import type { ExecutionPoolId, ProviderDriverKind } from "@t3tools/contracts";
import { ScaleIcon } from "lucide-react";
import type { useExecutionPools } from "../hooks/useExecutionPools";
import { ComposerSelectControl } from "./chat/ComposerControl";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";

/** The upstream composer destination picker, with pool identities replacing machine destinations. */
export function ExecutionPoolSelector(props: {
  catalog: ReturnType<typeof useExecutionPools>;
  selectedId: ExecutionPoolId | null;
  driver: ProviderDriverKind;
  locked: boolean;
  automatic: boolean;
  onSelect: (id: ExecutionPoolId) => void;
  onAutomatic?: (() => void) | undefined;
}) {
  const floatingLayerProps = useComposerMenuProps();
  const pools = props.catalog.snapshot?.pools ?? [];
  const selected = pools.find((pool) => pool.id === props.selectedId);
  const label = selected?.label ?? props.selectedId ?? "Assigned pool";
  const autoLabel = props.catalog.pending && !props.selectedId ? "Checking pools…" : "Auto balance";
  const items = [
    ...(props.onAutomatic ? [{ value: "auto", label: autoLabel }] : []),
    ...pools.map((pool) => ({ value: `pool:${pool.id}`, label: pool.label })),
  ];

  if (props.locked) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className="inline-flex h-7 min-w-0 max-w-full items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
              data-composer-context-control
            />
          }
        >
          <EnvironmentMachineIcon kind="cloud" className="size-3 shrink-0" />
          <ComposerContextLabel>{label}</ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      items={items}
      value={props.automatic ? "auto" : props.selectedId ? `pool:${props.selectedId}` : null}
      onOpenChange={(open) => {
        if (open) props.catalog.refresh();
      }}
      onValueChange={(value) => {
        if (value === "auto") {
          props.onAutomatic?.();
          return;
        }
        const pool = pools.find((entry) => `pool:${entry.id}` === value);
        if (pool) props.onSelect(pool.id);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerSelectControl
              size="xs"
              className="min-w-0 max-w-full"
              aria-label="Execution pool"
              data-composer-shortcut="composer.host"
              data-composer-context-control
            />
          }
        >
          {props.automatic ? (
            <ScaleIcon className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            <EnvironmentMachineIcon kind="cloud" className="size-3 shrink-0" />
          )}
          <ComposerContextLabel>
            <SelectValue placeholder={props.catalog.pending ? "Checking pools…" : "Run on"} />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          {props.automatic ? `${autoLabel}${props.selectedId ? ` · ${label}` : ""}` : label}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup alignItemWithTrigger={false} {...floatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>Run on</SelectGroupLabel>
          {props.onAutomatic ? (
            <SelectItem
              value="auto"
              onClick={() => {
                if (props.automatic) props.onAutomatic?.();
              }}
            >
              <span className="inline-flex items-center gap-1.5">
                <ScaleIcon className="size-3" aria-hidden="true" />
                {autoLabel}
              </span>
            </SelectItem>
          ) : null}
          {pools.map((pool) => (
            <SelectItem
              key={pool.id}
              value={`pool:${pool.id}`}
              disabled={!pool.available || !pool.providerDrivers.includes(props.driver)}
            >
              <span className="inline-flex items-center gap-1.5">
                <EnvironmentMachineIcon kind="cloud" className="size-3" />
                {pool.label}
                {!pool.available ? " (unavailable)" : ""}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
}
