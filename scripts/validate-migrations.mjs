import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const migrationsDirectory = join(repositoryRoot, 'db', 'migrations');
const filePattern = /^(\d{4})_[a-z0-9_]+\.(up|down)\.sql$/;
const requiredTables = new Set([
  'users',
  'sessions',
  'devices',
  'idempotency_keys',
  'audit_logs',
  'game_events',
  'game_snapshots',
  'game_command_results',
  'outbox_messages',
  'game_presence',
  'game_deadlines'
]);

const files = readdirSync(migrationsDirectory).filter(file => file.endsWith('.sql')).sort();
const migrations = new Map();
const problems = [];

for (const file of files) {
  const match = filePattern.exec(file);
  if (!match) {
    problems.push(`${file}: expected NNNN_name.up.sql or NNNN_name.down.sql`);
    continue;
  }
  const [, version, direction] = match;
  const entry = migrations.get(version) || {};
  entry[direction] = file;
  migrations.set(version, entry);
}

const versions = [...migrations.keys()].sort();
versions.forEach((version, index) => {
  const expected = String(index + 1).padStart(4, '0');
  if (version !== expected) problems.push(`migration versions must be contiguous; expected ${expected}, found ${version}`);
  const entry = migrations.get(version);
  if (!entry.up || !entry.down) problems.push(`${version}: up/down pair is incomplete`);
  for (const direction of ['up', 'down']) {
    if (!entry[direction]) continue;
    const source = readFileSync(join(migrationsDirectory, entry[direction]), 'utf8');
    if (!/^\s*BEGIN;\s*/.test(source)) problems.push(`${entry[direction]}: missing BEGIN transaction`);
    if (!/COMMIT;\s*$/.test(source)) problems.push(`${entry[direction]}: missing final COMMIT`);
  }
});

const upSource = versions
  .map(version => migrations.get(version)?.up)
  .filter(Boolean)
  .map(file => readFileSync(join(migrationsDirectory, file), 'utf8'))
  .join('\n');
for (const table of requiredTables) {
  const declaration = new RegExp(`CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?${table}\\b`, 'i');
  if (!declaration.test(upSource)) problems.push(`required table is missing from up migrations: ${table}`);
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`migrations: ${versions.length} paired PostgreSQL migrations passed validation`);
}
