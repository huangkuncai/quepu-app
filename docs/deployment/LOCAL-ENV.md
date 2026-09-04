# OPS-101 本地开发环境手册

> 状态：开发/演示基线，不适用于生产部署。  
> 适用范围：本地 Node 服务、PostgreSQL、Redis，以及真实 adapter smoke 验证。  
> 关联任务：OPS-101、BE-104、BE-105。

本手册中的命令都从仓库根目录执行（当前目录名可能是
宿松app.migrated-backup）。默认账号、密码和端口只用于本机开发，不能复制到
staging/production。数据库备份可能包含用户、房间和审计数据，必须当作敏感文件处理。

## 1. 前置条件

- Node.js 20 或更高版本，以及 npm。
- Docker Desktop，或 macOS/Linux 上的 Colima + Docker CLI。
- 可选：psql、pg_dump、pg_restore。没有宿主机工具时，命令会通过
  PostgreSQL 容器中的同名工具执行。

先确认工具和 Compose 文件可用：

~~~
node --version
npm --version
docker compose version
npm run validate:migrations
docker compose -f infra/docker-compose.dev.yml config --quiet
~~~

## 2. 创建本地配置

~~~bash
if [ -e .env ]; then
  echo '.env already exists; inspect it and keep it'
else
  cp .env.example .env
fi
~~~

.env.example 不含秘密。Node 不会自动读取 .env 文件；如果要让 npm run dev 使用
文件中的值，请在当前 shell 导出它们（关闭 shell 后不会影响系统配置）：

~~~
set -a
. ./.env
set +a
~~~

开发默认使用内存适配器：PERSISTENCE_BACKEND=memory。要让服务连接本地 Compose 的
PostgreSQL/Redis，把 .env 中的值改为：

~~~
PERSISTENCE_BACKEND=postgres
DATABASE_URL=postgresql://susong:susong_dev_only@127.0.0.1:5432/susong
REDIS_URL=redis://127.0.0.1:6379
~~~

也可以只对单次命令设置变量，避免修改 .env：

~~~
PERSISTENCE_BACKEND=postgres \
DATABASE_URL=postgresql://susong:susong_dev_only@127.0.0.1:5432/susong \
REDIS_URL=redis://127.0.0.1:6379 \
npm start
~~~

AUTH_MODE=stub、FEATURE_REAL_RULES=false 和 FEATURE_REAL_DIAMONDS=false 只允许
开发/测试使用，不能作为上线配置。

## 3. 启动 PostgreSQL 和 Redis

使用 Colima 时先启动虚拟机；Docker Desktop 用户跳过下面命令。已有 Colima profile
若资源已配置，可直接执行 `colima start`；新 profile 可使用以下资源基线：

~~~
# 已有 profile：colima start
# 新 profile（首次创建时执行）：
colima start --runtime docker --cpus 2 --memory 4 --disk 20
docker context use colima
~~~

启动服务并查看健康状态：

~~~
docker compose -f infra/docker-compose.dev.yml up -d postgres redis
docker compose -f infra/docker-compose.dev.yml ps
docker compose -f infra/docker-compose.dev.yml exec -T postgres pg_isready -U susong -d susong
docker compose -f infra/docker-compose.dev.yml exec -T redis redis-cli ping
~~~

预期最后两条分别包含 accepting connections 和 PONG。若仍在启动，等待几秒后重试；
详细原因可查看：

~~~
docker compose -f infra/docker-compose.dev.yml logs --tail=100 postgres redis
~~~

Compose 使用命名卷保存数据。docker compose stop、down（不带 -v）不会删除这些卷。

## 4. 应用迁移

先验证迁移文件成对、连续且带事务：

~~~
npm run validate:migrations
~~~

在默认 susong 数据库首次初始化时，可把迁移文件逐个送入容器内的 psql。只在新数据库
执行一次；重复执行会因为表已存在而失败，以避免无意覆盖数据：

~~~
for migration in db/migrations/*.up.sql; do
  docker compose -f infra/docker-compose.dev.yml exec -T postgres \
    psql -U susong -d susong -v ON_ERROR_STOP=1 < "$migration"
done
~~~

迁移顺序由四位数字前缀决定（当前为 0001～0006）。npm run verify:real 会在临时数据库中
自动应用全部迁移，因此更适合日常 adapter 验证，不会写入默认 susong 数据库：

~~~
npm run verify:real
~~~

脚本成功后会输出 status: "ok"，并在退出时删除临时数据库。若进程被强制中断，先列出
残留的精确数据库名，再逐个确认后删除；不要对数据库名使用通配符删除：

~~~
docker compose -f infra/docker-compose.dev.yml exec -T postgres \
  psql -U susong -d postgres -Atc \
  "SELECT datname FROM pg_database WHERE datname LIKE 'susong_verify_%' ORDER BY datname"
~~~

## 5. 启动服务与本地检查

内存开发模式：

~~~
npm run dev
~~~

已应用迁移并准备好 PG/Redis 后，使用真实 adapter（缺少连接配置时会失败，不会静默
回退到内存）：

~~~
PERSISTENCE_BACKEND=postgres \
DATABASE_URL=postgresql://susong:susong_dev_only@127.0.0.1:5432/susong \
REDIS_URL=redis://127.0.0.1:6379 \
npm start
~~~

另一个终端运行质量门：

~~~
npm run check
npm run scan:secrets
npm audit --omit=dev --audit-level=high
~~~

## 6. 停止、保留和清理数据

按破坏性从低到高执行：

~~~
# 只停止容器，保留容器和数据卷
docker compose -f infra/docker-compose.dev.yml stop

# 删除容器和网络，保留命名数据卷
docker compose -f infra/docker-compose.dev.yml down

# 同时删除本项目的 PostgreSQL/Redis 命名卷（不可逆，确认后再执行）
docker compose -f infra/docker-compose.dev.yml down -v

# 若本机使用 Colima，确认没有其他项目依赖后再停止虚拟机
colima stop
~~~

只重置默认 PostgreSQL 数据库时，不必删除整个 Docker 卷。先停止应用进程，再执行下面的
两个明确目标命令，然后重新应用第 4 节迁移：

~~~
docker compose -f infra/docker-compose.dev.yml exec -T postgres \
  dropdb -U susong --maintenance-db=postgres --if-exists --force susong
docker compose -f infra/docker-compose.dev.yml exec -T postgres \
  createdb -U susong --maintenance-db=postgres -O susong susong
~~~

Redis 只保存在线状态、短期锁和发布/订阅数据；在专用本地实例中清空它不会替代
PostgreSQL 事件事实来源：

~~~
# 仅确认该 compose 服务确实是本地开发 Redis 后执行
docker compose -f infra/docker-compose.dev.yml exec -T redis redis-cli FLUSHDB
~~~

## 7. PostgreSQL 备份与恢复演练

建议把备份放到已加入 .gitignore 的 .local-backups/，不要提交或上传。文件名带时间戳，
并在写入前检查目标不存在，避免无意覆盖旧备份：

~~~
umask 077
mkdir -p .local-backups
chmod 700 .local-backups
BACKUP_FILE=".local-backups/susong-$(date +%Y%m%d-%H%M%S).dump"
if [ -e "$BACKUP_FILE" ]; then
  echo "backup already exists: $BACKUP_FILE" >&2
  exit 1
fi
docker compose -f infra/docker-compose.dev.yml exec -T postgres \
  pg_dump -U susong -d susong --format=custom \
  > "$BACKUP_FILE"
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$BACKUP_FILE"
elif command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$BACKUP_FILE"
fi
echo "created $BACKUP_FILE"
~~~

恢复演练默认恢复到单独数据库，避免覆盖正在使用的 susong。下面是一段完整命令，
把 `BACKUP_FILE` 改成要演练的备份路径；数据库名使用当前时间生成，避免重复：

~~~
BACKUP_FILE=".local-backups/susong-YYYYMMDD-HHMMSS.dump"
RESTORE_DB="susong_restore_$(date +%Y%m%d_%H%M%S)"
test -r "$BACKUP_FILE"
docker compose -f infra/docker-compose.dev.yml exec -T postgres \
  createdb -U susong --maintenance-db=postgres -O susong "$RESTORE_DB"
docker compose -f infra/docker-compose.dev.yml exec -T postgres \
  pg_restore -U susong -d "$RESTORE_DB" --no-owner --exit-on-error \
  < "$BACKUP_FILE"
docker compose -f infra/docker-compose.dev.yml exec -T postgres \
  psql -U susong -d "$RESTORE_DB" -c '\dt'
~~~

确认恢复结果后，删除这一个明确的演练数据库（可选；将同一 `RESTORE_DB` 变量保留在
当前 shell 中）：

~~~
docker compose -f infra/docker-compose.dev.yml exec -T postgres \
  dropdb -U susong --maintenance-db=postgres --if-exists --force "$RESTORE_DB"
~~~

Redis 不作为牌局事实来源；通常只需重启/清空后让应用重新建立缓存和锁。若要保留本地
Redis 快照，可先执行 BGSAVE，但这不是生产备份替代品：

~~~
docker compose -f infra/docker-compose.dev.yml exec -T redis redis-cli BGSAVE
docker compose -f infra/docker-compose.dev.yml cp redis:/data/dump.rdb \
  .local-backups/redis-local.rdb
~~~

正式环境的备份频率、加密、异地复制、RPO/RTO 和恢复审批尚未确定；本节只覆盖开发演练。

## 8. 故障排查和边界

- 5432 或 6379 被占用：执行 docker compose ps 和宿主机端口检查，确认没有第二套
  开发栈；不要直接修改生产连接串来绕过冲突。
- verify:real 报 postgres_unavailable 或 redis_unavailable：先检查第 3 节健康命令，
  再确认 DATABASE_URL/REDIS_URL 指向本机 Compose，而不是空值或线上地址。
- 迁移中途失败：保留错误输出，修复具体 SQL 后在一个新的临时数据库重新演练；不要直接
  删除事件、快照或审计表来“修复”生产数据。
- 真实 adapter smoke、单进程测试和本地备份恢复通过，不等于生产多实例、外部身份服务、
  规则裁判、三端真机安装或签名发布已经完成。
