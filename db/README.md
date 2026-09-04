# Local data baseline

> 中文环境、Docker/Colima 启停、清理和备份恢复手册：
> [docs/deployment/LOCAL-ENV.md](../docs/deployment/LOCAL-ENV.md)。

The migration set is intentionally plain PostgreSQL SQL and does not require a
Node database driver. Apply files in numeric order and roll them back in the
opposite order. The commands below target only the bundled local Compose
database:

```bash
docker compose -f infra/docker-compose.dev.yml up -d postgres redis
export DATABASE_URL=postgresql://susong:susong_dev_only@127.0.0.1:5432/susong
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0001_identity.up.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0002_sessions_idempotency.up.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0003_audit_logs.up.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0004_game_events_actor.up.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0005_game_presence_overlay.up.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0006_game_deadlines.up.sql
```

If `psql` is not installed on the host, run the same files through the
`postgres` service (`docker compose ... exec -T postgres psql ...`). The full
loop, health checks, and an explicitly scoped backup/restore drill are in the
OPS-101 manual.

For a disposable local database, rollback in reverse dependency order with
the explicit list below. Stop the app first and verify the Compose target is
the local `susong` database; this removes the schema and its data:

```bash
set -e
for migration in \
  db/migrations/0006_game_deadlines.down.sql \
  db/migrations/0005_game_presence_overlay.down.sql \
  db/migrations/0004_game_events_actor.down.sql \
  db/migrations/0003_audit_logs.down.sql \
  db/migrations/0002_sessions_idempotency.down.sql \
  db/migrations/0001_identity.down.sql; do
  docker compose -f infra/docker-compose.dev.yml exec -T postgres \
    psql -U susong -d susong -v ON_ERROR_STOP=1 < "$migration"
done
```

The down files are intended for local cleanup/recovery only. Production
migration tooling must record applied versions and use an approved rollback or
forward-fix procedure.

For the bundled development compose service, use:

```bash
DATABASE_URL=postgresql://susong:susong_dev_only@127.0.0.1:5432/susong
```

项目根目录的 `verify:real` 脚本会创建临时数据库、按顺序应用全部迁移，
验证 PostgreSQL event/snapshot/deadline adapter 与 Redis fencing，再删除该临时数据库：

```bash
npm run verify:real
```

脚本需要 `pg`、`redis` Node 依赖（已随 `npm install` 安装）以及可访问的
PostgreSQL/Redis；不会清理或覆盖默认 `susong` 数据库。

在同一环境执行 `npm run verify:multi-instance` 可验证两个独立 PostgreSQL
连接和 Redis fencing client 下的重复命令幂等、并发房间写入、连续
`roomVersion`、outbox 与最终 `snapshotHash` 收敛。该脚本同样使用临时数据库；
它是开发 smoke，不替代生产多进程部署、滚动重启或故障演练。

Rollback is explicit and must be performed in reverse order (`0006`, then `0005`,
then `0004`, then `0003`, then `0002`, then `0001`). The down files use `IF EXISTS` to make a failed local
cleanup recoverable; production migration tooling must still record applied
migrations and refuse to skip versions.

The migrations create identity/session/replay/audit data plus the BE-202 room
event stream, versioned snapshots, command results, transactional outbox and
the durable deadline claim/lease table. `game_deadlines` stores scheduler
intent and completion state; a worker must claim a due row with its lease token
before dispatching a guarded room command. An expired lease may be reclaimed by
another worker, while completion with a stale token is rejected.
The `game_presence` table is a mutable room-level connection overlay; it is
version-guarded but deliberately does not advance the game event cursor.
Scores and diamonds remain separate append-only ledgers owned by later tasks.
Raw access or refresh tokens are never stored; only their hashes are persisted.

`npm run validate:migrations` checks filename pairing, contiguous versioning,
transaction wrappers and the required table set without needing a running
PostgreSQL instance.
