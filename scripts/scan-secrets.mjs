import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ignored = new Set(['.git', 'node_modules', 'coverage', 'dist']);
const textExtensions = new Set(['.js', '.mjs', '.json', '.yaml', '.yml', '.md', '.sql', '.env', '.example']);
const patterns = [
  /-----BEGIN (?:RSA|EC|OPENSSH|PRIVATE) KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /(?:aws_secret_access_key|private_key)\s*[:=]\s*['"][^'"\s]{16,}/i
];
const findings = [];

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (textExtensions.has(extname(entry.name)) || entry.name === '.env.example') {
      const source = readFileSync(path, 'utf8');
      for (const pattern of patterns) if (pattern.test(source)) findings.push(path);
    }
  }
}

walk(root);
if (findings.length > 0) {
  console.error(`secret scan failed:\n${[...new Set(findings)].join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('secret scan: no high-confidence credential patterns found');
}

