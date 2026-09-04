# ADR-004: Durable Deadline Claim Lease

## Status

Accepted for the BE-204 development/staging baseline. Local PostgreSQL/Redis
adapter and two-client multi-instance smoke verification pass; production
process supervision, rolling restart and fault-drill verification remain
outstanding.

## Context

An in-process timer is only a wake-up mechanism. After a restart, or when two
server instances arm the same room turn, both timers may fire. The room actor's
version guard prevents an invalid state transition, but it does not provide a
durable single-dispatch boundary or a way to recover a worker that died while
dispatching.

## Decision

Store one immutable deadline definition per `deadlineId` in `game_deadlines`.
The storage port exposes `upsert`, `get`, `list`, `claim`, `complete`, `fail`,
`cancel` and `cancelRoom`.

- `claim` is an atomic transition to `CLAIMED` for a due row. It records a
  worker id, a monotonically increasing lease token and an expiry timestamp.
- A live lease held by another worker returns `LEASE_HELD`; an expired lease
  can be reclaimed with a new token. A same-worker retry is idempotent.
- `complete` requires the worker id and lease token. A stale token is rejected
  with `FENCING_TOKEN_STALE`; terminal states are immutable and replayable.
- The scheduler still uses a local timer, but it must claim before dispatching.
  When another worker holds a lease it wakes again at lease expiry, so a
  crashed worker can be replaced. Room refresh cancels obsolete scheduled
  rows while leaving a live claim alone.

Memory and PostgreSQL adapters implement the same port. The Memory adapter is
for deterministic tests and development only; the PostgreSQL adapter uses a
transaction and `SELECT ... FOR UPDATE` around each claim/completion. The
local `verify:real` and `verify:multi-instance` scripts exercise these paths,
but do not establish production availability or recovery SLOs.

## Consequences

The event stream and room command idempotency remain the authoritative game
guards; deadline leases add execution ownership and recovery. Lease duration,
clock skew, retry policy and production worker supervision must be validated in
the deployment environment before claiming multi-instance guarantees.
