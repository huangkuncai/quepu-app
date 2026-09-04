import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const roots = ['src', 'scripts', 'test'];
const sourceExtensions = new Set(['.js', '.mjs']);

function collect(directory) {
  const absolute = join(repositoryRoot, directory);
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap(entry => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) return collect(relative(repositoryRoot, child));
    return sourceExtensions.has(extname(entry.name)) ? [child] : [];
  });
}

const files = roots.flatMap(collect).sort();
const problems = [];

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  if (/^[ \t]+$/m.test(source)) problems.push(`${relative(repositoryRoot, file)}: trailing whitespace`);
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    problems.push(`${relative(repositoryRoot, file)}: syntax check failed\n${result.stderr || result.stdout}`);
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`lint: ${files.length} JavaScript files passed syntax and whitespace checks`);
}
