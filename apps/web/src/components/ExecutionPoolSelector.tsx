import type { ExecutionPoolId, ProviderDriverKind } from "@t3tools/contracts";
import type { useExecutionPools } from "../hooks/useExecutionPools";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

export function ExecutionPoolSelector(props: {
  catalog: ReturnType<typeof useExecutionPools>;
  selectedId: ExecutionPoolId | null;
  driver: ProviderDriverKind;
  locked: boolean;
  automatic: boolean;
  onSelect: (id: ExecutionPoolId) => void;
  onAutomatic?: (() => void) | undefined;
}) {
  const pools = props.catalog.snapshot?.pools ?? [];
  return (
    <Select
      value={props.automatic ? "auto" : props.selectedId ? `pool:${props.selectedId}` : null}
      disabled={props.locked}
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
      <SelectTrigger size="xs" aria-label="Execution pool" data-composer-shortcut="composer.host">
        <SelectValue
          placeholder={
            props.locked
              ? "Assigned pool"
              : props.catalog.pending
                ? "Checking pools…"
                : "Choose pool"
          }
        >
          {props.automatic
            ? `Auto balance${props.selectedId ? ` · ${pools.find((pool) => pool.id === props.selectedId)?.label ?? props.selectedId}` : ""}`
            : (pools.find((pool) => pool.id === props.selectedId)?.label ?? props.selectedId)}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {props.onAutomatic ? <SelectItem value="auto">Auto balance</SelectItem> : null}
        {pools.map((pool) => (
          <SelectItem
            key={pool.id}
            value={`pool:${pool.id}`}
            disabled={!pool.available || !pool.providerDrivers.includes(props.driver)}
          >
            {pool.label}
            {!pool.available ? " (unavailable)" : ""}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
