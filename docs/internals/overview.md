# Architecture

T3 Code is a web application. The central service owns SQLite, conversations, authentication,
and durable orchestration state. Execution belongs to TypeScript workers in Kubernetes Agent
Sandbox. T3 owns sandbox lifecycle through the Kubernetes API and builds the worker image.
The central service is a single writer; deployments use one replica with Recreate rollout.

## Ownership boundaries

Provider processes, terminals, Git, project files, browsers, computer control, and the IDE run
inside the bound execution workspace. New root threads receive independent workspaces. Delegated
children inherit the parent's workspace while retaining separate provider and MCP identities.
An unavailable worker must never redirect execution to the central server's filesystem or binaries.
Conversation SQLite stays central so replacing a worker cannot replace or fork conversation state.

[Native sandbox lifecycle](../../apps/server/src/sandbox/SandboxLifecycle.ts) persists desired state,
allocation credentials, and worker identities centrally before creating Kubernetes resources. Passive
observation can finish an accepted stop but cannot create or resume compute. Explicit acquisition
reconciles a running request. Stops require worker quiescence and an unchanged lifecycle version;
worker replacement invalidates a pending stop. Workspace PVCs have no compute owner references and
survive both suspension and release.

The first native startup records existing workspace bindings as requiring cutover. Those workspaces
cannot provision empty replacement volumes. Restore their data using the
[cutover procedure](../../deploy/t3/README.md#move-an-existing-installation) before admitting execution.

Shared browser connection and domain state belongs in `packages/client-runtime`. Sandbox binaries
come from the pinned image build; authentication, model selection, and compatibility checks remain
runtime operations. Native desktop and mobile clients and native-device control are outside this fork.

The [RPC contract](../../packages/contracts/src/rpc.ts) is the boundary between independently
versioned clients and servers. Subscriptions send the state a client needs, so a client viewing one
thread does not pay for every thread's history. Authentication of a socket does not authorize every
method on it. See [environment auth](./environment-auth.md).

### Pull request linking compatibility

Browser clients and central servers can run different versions. Negotiate linking through the
environment descriptor, never through a client version or an assumed coordinated release:

| Environment capability                | Client behavior                                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `threadPullRequests: true`            | Use persisted `pullRequests[]`, multi-link commands, stack UI, and reverse thread lookup.                         |
| Only `threadPullRequestLinking: true` | Use `linkedPullRequest` and the existing `thread.meta.update` single-link operation. Do not call multi-link RPCs. |
| Neither flag                          | Hide linking actions; existing branch-discovered PR display remains available.                                    |

New environments continue advertising the legacy flag, accepting legacy metadata commands, and
emitting the derived `linkedPullRequest` field for older clients. That hostless field includes only
links in the thread project's own repository; cross-host and cross-repository links require the
multi-link protocol. New clients accept snapshots that
omit `pullRequests`. Retain the legacy wire fields, projection column, and replay support; this feature
does not schedule their removal. Missing new capabilities must also override cached multi-link data
after an environment downgrade.

Provider-specific behavior belongs behind an adapter. Orchestration works with normalized commands
and events, so adding a provider should not require branches throughout the domain or clients.
See [provider constraints](./providers.md).

## Settings ownership

Client preferences stay in the current client; environment defaults and project overrides stay
on their owning server. The web settings target is URL state, resolved against current
connections and project membership. An unavailable target must not fall back to another environment.
**All environments** is an explicit bulk edit of connected, loaded servers, not a durable global
default or a promise to synchronize offline or future environments. Project-group targets similarly
select known environment-local checkouts; the group itself does not store inherited defaults.

## Durable intent and side effects

The event log is the source of truth for orchestration state. The
[v2 orchestrator](../../apps/server/src/orchestration-v2/Orchestrator.ts) serializes commands and
decides events without performing provider or filesystem work.
[EventSink](../../apps/server/src/orchestration-v2/EventSink.ts) commits events, persisted projections,
the accepted command receipt, and outbox effects in one database transaction. Subscribers receive
events after that commit. This keeps command retries idempotent and prevents a persisted projection
from getting ahead of the event log.

The [effect worker](../../apps/server/src/orchestration-v2/EffectWorker.ts) performs side effects
after intent has been recorded, then feeds results back into orchestration. A command acknowledgement
therefore means the intent committed, not that the provider, checkpoint, or other follow-up work
finished. Keep external I/O out of command decisions and the database transaction. Effects tied to
a lost provider process cannot simply replay; recovery retires them before admitting new work.

Persisted events must remain decodable on replay. Changing a schema affects old environments at
startup as well as live RPC traffic. Compatibility work must account for stored history, not just
what the newest client sends.

## Turn completion and checkpoints

A provider turn ending and its follow-up work settling are separate milestones. Orchestration
records provider turn and run state independently from
[run finalization](../../apps/server/src/orchestration-v2/RunFinalizationService.ts). A late
checkpoint or diff must not extend the recorded provider duration or keep the client showing
provider work as active. PR discovery after completion also checks that the checkout still matches
the thread's non-default branch and that a newer run is not active.

[Checkpoints](../../apps/server/src/checkpointing/CheckpointStore.ts) use hidden Git refs to
capture workspace state without adding commits to the user's branch. A revert must coordinate
workspace state with the provider conversation. A provider that cannot roll back its conversation
must reject that operation before changing the filesystem.

Thread settlement is server-owned. The
[settlement service](../../apps/server/src/orchestration-v2/ThreadSettlementService.ts) evaluates PR
and inactivity settings without a connected client. Merge notifications invalidate cached PR state
and trigger a check. A merge outside T3, such as an agent running `gh pr merge`, sends no
notification, so the [PR sync reactor](../../apps/server/src/orchestration-v2/PullRequestSyncReactor.ts)
re-reads a thread's open links when a run that ran a merge or close command ends. The guarded
`thread.auto-settle` command rejects newer activity, explicit settlement overrides, and live or
blocked work. It records the activity timestamp for stable
sorting and detaches idle provider sessions. Clients render the persisted result; they do not
derive settlement from their own clocks or PR caches.

## Waiting for asynchronous work

Tests use [drainable workers](../../packages/shared/src/DrainableWorker.ts) to wait until both the
queue and its current item have finished. An empty queue alone does not prove the worker is idle.

V2 tests also drain the effect worker or await a specific persisted event or receipt. Test signals
are separate from the durable command receipts that make dispatch idempotent. Production behavior
must use persisted state and events, not test instrumentation or assumptions about elapsed time.

See the [glossary](./glossary.md) for shared terms and the
[development runbook](../operations/development.md) for setup and checks.
