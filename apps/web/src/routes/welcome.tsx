import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { NoProjectsHero } from "../components/NoProjectsHero";
import { ManagedOnboardingGate } from "../components/onboarding/ManagedOnboardingGate";
import { usePrimaryEnvironment } from "../state/environments";

export const Route = createFileRoute("/welcome")({
  beforeLoad: ({ context }) => {
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: WelcomeRouteView,
});

function WelcomeRouteView() {
  const navigate = useNavigate();
  const primaryEnvironment = usePrimaryEnvironment();
  const onDone = useCallback(() => navigate({ to: "/", replace: true }), [navigate]);
  return (
    <>
      <NoProjectsHero />
      {primaryEnvironment ? (
        <ManagedOnboardingGate environmentId={primaryEnvironment.environmentId} onDone={onDone} />
      ) : null}
    </>
  );
}
