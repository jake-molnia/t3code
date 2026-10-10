import { createFileRoute, redirect, useLocation, useNavigate } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { NoProjectsHero } from "../components/NoProjectsHero";
import { ManagedOnboardingGate } from "../components/onboarding/ManagedOnboardingGate";
import { usePrimaryEnvironment } from "../state/environments";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { WelcomeWizard } from "../components/onboarding/WelcomeWizard";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";

const decodeEnvironmentId = Schema.decodeOption(EnvironmentId);

/** Onboarding overlays the workspace. Visiting /welcome reopens setup. */
export const Route = createFileRoute("/welcome")({
  beforeLoad: ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: WelcomeRouteView,
});

function WelcomeRouteView() {
  const { authGateState } = Route.useRouteContext();
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const resumeEnvironmentId = hash.startsWith("agents:")
    ? Option.getOrUndefined(decodeEnvironmentId(hash.slice("agents:".length)))
    : undefined;
  // The root shell can remount this pending outlet after the location changes.
  // Never reopen setup while the destination route is still loading.
  const isWelcomeRoute = useLocation({ select: (location) => location.pathname === "/welcome" });
  const [dismissed, setDismissed] = useState(false);
  const openNewThread = useNewThreadHandler();
  const primaryEnvironment = usePrimaryEnvironment();
  const onDone = useCallback(
    async (projectRef?: ScopedProjectRef) => {
      setDismissed(true);
      if (projectRef !== undefined) {
        await openNewThread(projectRef, { replace: true }).catch(() =>
          navigate({ to: "/", replace: true }),
        );
        return;
      }
      await navigate({ to: "/", replace: true });
    },
    [openNewThread, navigate],
  );
  const localAvailable = authGateState.status === "authenticated";
  const wizard = (
    <WelcomeWizard
      localAvailable={localAvailable}
      resumeEnvironmentId={resumeEnvironmentId}
      onDone={onDone}
    />
  );
  return (
    <>
      <NoProjectsHero />
      {isWelcomeRoute && !dismissed ? (
        localAvailable ? (
          primaryEnvironment ? (
            <ManagedOnboardingGate environmentId={primaryEnvironment.environmentId} onDone={onDone}>
              {wizard}
            </ManagedOnboardingGate>
          ) : null
        ) : (
          wizard
        )
      ) : null}
    </>
  );
}
