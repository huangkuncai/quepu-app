import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCommand } from '../src/protocol/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const schemaDir = join(root, 'schemas', 'protocol');
const schemaFiles = readdirSync(schemaDir).filter(name => name.endsWith('.json'));
for (const name of schemaFiles) JSON.parse(readFileSync(join(schemaDir, name), 'utf8'));

const fixturePath = join(root, 'test', 'fixtures', 'protocol', 'valid-command.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
validateCommand(fixture);
console.log(`protocol: ${schemaFiles.length} JSON schemas parsed; valid command fixture accepted`);

