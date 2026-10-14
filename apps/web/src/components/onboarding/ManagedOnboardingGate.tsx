import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { useExecutionPools } from "../../hooks/useExecutionPools";
import { useCompleteOnboarding } from "../../onboarding/firstRun";
import { Button } from "../ui/button";

/** Managed installations already have execution and providers; use normal project creation. */
export function ManagedOnboardingGate(props: {
  environmentId: EnvironmentId;
  onDone: () => void | Promise<void>;
}) {
  const { onDone } = props;
  const catalog = useExecutionPools(props.environmentId);
  const complete = useCompleteOnboarding();
  const completion = useRef<{ attempt: number; promise: Promise<void> } | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const ready = catalog.snapshot !== null;
  useEffect(() => {
    if (!ready) return;
    let active = true;
    if (completion.current?.attempt !== retry)
      completion.current = { attempt: retry, promise: complete() };
    void completion.current.promise
      .then(async () => {
        if (active) await onDone();
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [ready, complete, onDone, retry]);

  if (failed || catalog.failed) {
    return (
      <div role="alert" className="flex items-center justify-center gap-3 p-4">
        <span>Could not finish setup.</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            completion.current = null;
            setFailed(false);
            setRetry((value) => value + 1);
            catalog.refresh();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }
  return null;
}
