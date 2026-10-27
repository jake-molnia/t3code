import type { EnvironmentId, ExecutionPool } from "@t3tools/contracts";
import { useExecutionPools } from "~/hooks/useExecutionPools";

import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "~/hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { EnvironmentRow } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { searchableSetting } from "./settingsSearch";

const preferences = [
  { value: 100, label: "Prefer" },
  { value: 50, label: "Normal" },
  { value: 25, label: "Less often" },
  { value: 0, label: "Manual only" },
] as const;

type LoadPreference = (typeof preferences)[number]["value"];

/** Snaps a saved weight (older builds stored a slider value) onto the four preferences. */
export function loadPreferenceForWeight(weight: number | undefined): LoadPreference {
  if (weight === undefined || weight === 50) return 50;
  if (weight === 0) return 0;
  return weight < 50 ? 25 : 100;
}

function preferenceLabel(preference: LoadPreference): string {
  return preferences.find((entry) => entry.value === preference)!.label;
}

/**
 * Summarizes pool preferences that differ from Normal.
 */
export function summarizeLoadPreferences(
  pools: ReadonlyArray<Pick<ExecutionPool, "id" | "label">>,
  weights: Readonly<Record<string, number>>,
): string | null {
  const parts = pools.flatMap((pool) => {
    const preference = loadPreferenceForWeight(weights[pool.id]);
    return preference === 50 ? [] : [`${pool.label} ${preferenceLabel(preference).toLowerCase()}`];
  });
  return parts.length === 0 ? null : parts.join(" · ");
}

export function LoadBalancingSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = useClientSettings();
  const settingsHydrated = useClientSettingsHydrated();
  const updateSettings = useUpdateClientSettings();

  const catalog = useExecutionPools(environmentId);
  const pools = catalog.snapshot?.pools ?? [];
  if (!catalog.snapshot || pools.length === 0) {
    return (
      <FoldedSettingsSection
        id="load-balancing"
        title="Execution pools"
        summary={catalog.failed ? "Unavailable" : catalog.snapshot ? "None configured" : "Loading…"}
      >
        <p className="px-4 py-3 text-xs text-muted-foreground">
          {catalog.failed
            ? "Could not load execution pools."
            : "Execution pools are managed by this service. Your projects and conversations remain available while execution is unavailable."}
        </p>
        {catalog.failed ? (
          <div className="px-4 pb-3">
            <Button size="sm" variant="outline" onClick={catalog.refresh}>
              Retry
            </Button>
          </div>
        ) : null}
      </FoldedSettingsSection>
    );
  }

  const { id } = searchableSetting("load-balancing");
  return (
    <FoldedSettingsSection
      id={id}
      title="Execution pools"
      summary={
        settings.loadBalancingEnabled
          ? summarizeLoadPreferences(pools, settings.loadBalancingWeights)
          : "Off"
      }
      control={
        <Switch
          aria-label="Automatically balance load"
          checked={settings.loadBalancingEnabled}
          disabled={!settingsHydrated}
          onCheckedChange={(loadBalancingEnabled) => updateSettings({ loadBalancingEnabled })}
        />
      }
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        New threads use an available pool that supports the selected provider, based on your
        preferences and CPU and memory capacity when available.
      </p>
      {pools.map((pool) => (
        <EnvironmentRow
          key={pool.id}
          kind="cloud"
          label={pool.label}
          subtitle={
            pool.available
              ? pool.requestCapacity
                ? `${pool.requestCapacity.availableSlots} estimated slots available`
                : "Available"
              : "Unavailable"
          }
        >
          <Select
            items={preferences}
            value={loadPreferenceForWeight(settings.loadBalancingWeights[pool.id])}
            disabled={!settingsHydrated || !settings.loadBalancingEnabled}
            onValueChange={(value) => {
              if (value === null) return;
              updateSettings({
                loadBalancingWeights: {
                  ...settings.loadBalancingWeights,
                  [pool.id]: value,
                },
              });
            }}
          >
            <SelectTrigger size="xs" className="w-32" aria-label={`${pool.label} load preference`}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {preferences.map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </EnvironmentRow>
      ))}
    </FoldedSettingsSection>
  );
}
