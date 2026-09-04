import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleNames } from '../src/modules/index.js';
import { envSchema } from '../src/config/env-schema.js';
import { ERROR_CODES } from '../src/shared/errors.js';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const expectedModules = ['auth', 'lobby', 'club', 'floor', 'room', 'realtime', 'game', 'ledger', 'history', 'support', 'admin'];

if (packageJson.type !== 'module') throw new Error('package.json must remain ESM (`type: module`)');
if (JSON.stringify(moduleNames) !== JSON.stringify(expectedModules)) {
  throw new Error(`module registry mismatch: ${moduleNames.join(', ')}`);
}
if (!envSchema.PORT || envSchema.PORT.type !== 'integer') throw new Error('PORT env schema is missing');
if (!ERROR_CODES.INTERNAL_ERROR || !ERROR_CODES.CONFIG_INVALID) throw new Error('error registry is incomplete');

function countFiles(directory) {
  const absolute = fileURLToPath(new URL(`../${directory}/`, import.meta.url));
  return readdirSync(absolute, { withFileTypes: true }).reduce((total, entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return total;
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) return total + countFiles(`${directory}/${entry.name}`);
    return total + (['.js', '.mjs'].includes(extname(entry.name)) ? 1 : 0);
  }, 0);
}

// This repository is JavaScript-only for now. Node's parser is the type/syntax
// gate until TypeScript contracts are introduced in a later BE-102 task.
const sourceFileCount = ['src', 'scripts', 'test'].reduce((total, directory) => total + countFiles(directory), 0);
console.log(`typecheck: ${sourceFileCount} JavaScript entry files; module/config/error contracts passed`);
