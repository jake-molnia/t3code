import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";

import { PairingPendingSurface, PairingRouteSurface } from "../components/auth/PairingRouteSurface";

export const Route = createFileRoute("/pair")({
  beforeLoad: async ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status === "authenticated") {
      throw redirect({ to: "/", replace: true });
    }
    return {
      authGateState,
    };
  },
  component: PairRouteView,
  pendingComponent: PairRoutePendingView,
});

function PairRouteView() {
  const router = useRouter();
  const { authGateState } = Route.useRouteContext();

  if (!authGateState) {
    return null;
  }

  return (
    <PairingRouteSurface
      auth={authGateState.auth}
      onAuthenticated={() => {
        // Recreate the primary connection so its WebSocket and cached scopes
        // use the newly issued cookie after re-pairing.
        router.history.replace("/");
        router.history.flush();
        window.location.reload();
      }}
      {...(authGateState.errorMessage ? { initialErrorMessage: authGateState.errorMessage } : {})}
    />
  );
}

function PairRoutePendingView() {
  return <PairingPendingSurface />;
}
