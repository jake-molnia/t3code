# Deployment versions and restart recovery

The deployment image owns application upgrades. The server never downloads a
replacement runtime, restarts itself to install it, or restores SQLite during an
upgrade. Deployment rollback and database migration compatibility belong to the
operator.

The sandbox image workflow supplies `T3_SOURCE_REVISION` to both runtime images.
The shared bundle build passes it as `T3_BUILD_SOURCE_REVISION`, embedding the
source revision in the artifact used by About and triage. Images built outside
that workflow must supply the same build argument. Runtime environment values
cannot override the artifact's identity.

Source-checkout execution has no embedded revision and reports it as unknown,
including when launched inside a worker built from another commit. The dev runner
also clears the inherited image variable. A standalone bundle build can supply
`T3_BUILD_SOURCE_REVISION` explicitly; omitting it keeps provenance unknown.
The package version retains the fork's `.sandbox.N` suffix. The upstream baseline
is that version before the sandbox suffix; neither identifies the deployed fork
commit.

Settings > About follows the successful `main` runs of
[the sandbox-image workflow](../../.github/workflows/sandbox-images.yml), which
verifies and publishes both images before succeeding. GitHub Releases are not
this fork's publication channel. The check uses the newest successful run's
source revision, not the current branch head, so a failed or incomplete build
cannot advertise an unpublished image. A successful manual run on `main` also
qualifies. The notice links to the build's verified image tags and digests.

An image is newer only when GitHub's commit comparison reports that its source
descends from the deployed fork revision. Upstream release numbers cannot order
fork builds. Divergent history, missing successful builds, rate limits, and
offline checks are treated as unavailable. Checks are lazy, cached for one hour,
and bounded to five seconds. Deployment remains an operator action.

## Recovering interrupted threads

Restart continuation is an environment-owned preference, on by default. A
`settings.json` that fails to decode turns it off, since the file may hold an
opt-out. The
[v2 recovery service](../../apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts)
requires matching durable run, provider thread, session, and native resume identity.
Queued runs never started, so recovery holds them and continues the run they wait
behind. A finished run qualifies only when the restart cancelled its background work;
its continuation tells the provider what will not report back.

Recovery retires effects tied to the lost process and records continuation intent
in the durable outbox. That intent survives another restart before provider startup.
Continuation effects wait for activation; a slow provider must not delay the server's
readiness. Graceful shutdown captures intent before
closing providers, then reconciles after ingestion has stopped so a late completion
cannot be overwritten by a stale cancellation.

The [continuation handler](../../apps/server/src/orchestration-v2/RestartContinuation.ts)
rechecks the preference, provider selection, newer user work, a stop the user requested,
and maintenance turns such as `/compact` before dispatching. Intent and delivery both
refuse a thread that is archived, settled, or still snoozed, a provider turn that already
ended, and a run waiting on the user: an approval, question, or secret that was pending,
or that recovery closed on the cut turn. Message-capable questions stay answerable, so
they do not block. Delivery also stops after three consecutive continuations in one
`restartContinuationOfRunId` chain, so a turn that crashes the server cannot loop. Stable
command and message IDs prevent duplicate submissions after an outbox retry. Codex
resumes without adding provider prompt text unless the turn lost background work;
other adapters receive the continuation message through their normal turn path.

Delegated tasks (`delegate_task` child threads) are reconciled as their own threads,
never as the parent's background work. The orchestrator settles child results and
completion deliveries in a startup pass after reconciliation, because the terminal-run
listener ignores reconciliation's cancellations. A cancelled child whose restart
continuation is still pending in the outbox is not a result yet; the continuation's run
settles it, or the handler settles it when it declines to continue. Schedulers wait for
activation so they cannot start runs that reconciliation would then cancel.
