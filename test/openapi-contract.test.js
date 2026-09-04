import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('OpenAPI and AsyncAPI documents satisfy the checked REST contract', () => {
  const result = spawnSync(process.execPath, ['scripts/validate-contracts.mjs'], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /contracts: 2 OpenAPI\/AsyncAPI YAML documents parsed/);
});
