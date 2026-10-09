import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useContext, useEffect, useMemo } from "react";
import { serverEnvironment } from "../state/server";

export function useExecutionPools(environmentId: EnvironmentId, refreshWhileChoosing = false) {
  const registry = useContext(RegistryContext);
  const atom = useMemo(
    () => serverEnvironment.executionPools({ environmentId, input: {} }),
    [environmentId],
  );
  const result = useAtomValue(atom);
  const refresh = useCallback(() => registry.refresh(atom), [registry, atom]);
  useEffect(() => {
    if (!refreshWhileChoosing) return;
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [refresh, refreshWhileChoosing]);
  return {
    snapshot: result._tag === "Success" ? result.value : null,
    receivedAt: result._tag === "Success" ? result.timestamp : 0,
    pending: result._tag === "Initial" || result.waiting,
    failed: result._tag === "Failure",
    refresh,
  };
}
