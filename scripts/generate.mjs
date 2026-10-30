// Regenerates src/generated/schema.ts from the live Deadlock API OpenAPI spec.
//
//   npm run generate          write the types
//   npm run generate -- --check   fail if the committed types are out of date
//
// The generator runs through npx with its own TypeScript 5 so it never
// conflicts with the TypeScript version this project builds with.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SPEC_URL = 'https://api.deadlock-api.com/openapi.json';
const OUT = new URL('../src/generated/schema.ts', import.meta.url);
const check = process.argv.includes('--check');

const res = await fetch(SPEC_URL, { headers: { 'User-Agent': 'deadlock-sdk-codegen' } });
if (!res.ok) throw new Error(`Could not download the spec: ${res.status}`);
const spec = await res.json();

// The spec reuses some operationIds (e.g. `feed` for /v1/patches and
// /v2/patches), which makes openapi-typescript emit duplicate members.
// Give every duplicate a stable, path-derived suffix.
const seen = new Set();
for (const [path, ops] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(ops)) {
    if (!op || typeof op !== 'object' || !op.operationId) continue;
    if (seen.has(op.operationId)) {
      const suffix = path
        .split('/')
        .filter((s) => s && !s.startsWith('{'))
        .join('_')
        .replace(/[^a-zA-Z0-9_]/g, '_');
      op.operationId = `${op.operationId}_${method}_${suffix}`;
    }
    seen.add(op.operationId);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'deadlock-spec-'));
const specFile = join(dir, 'openapi.json');
const genFile = join(dir, 'schema.ts');
writeFileSync(specFile, JSON.stringify(spec));

execFileSync(
  'npx',
  [
    '--yes',
    '-p',
    'typescript@5',
    '-p',
    'openapi-typescript@7.13.0',
    'openapi-typescript',
    specFile,
    '--output',
    genFile,
    '--alphabetize',
    '--root-types',
    '--root-types-no-schema-prefix',
  ],
  { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' }
);

const banner = `/**
 * Generated from ${SPEC_URL}
 * (Deadlock API ${spec.info?.version ?? ''}, ${Object.keys(spec.paths).length} paths).
 * Do not edit by hand. Run \`npm run generate\` to update.
 */
/* eslint-disable */
`;
const next = banner + readFileSync(genFile, 'utf8');

if (check) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    // missing file counts as outdated
  }
  if (current !== next) {
    console.error(
      'src/generated/schema.ts is out of date with the live API spec. Run `npm run generate`.'
    );
    process.exit(1);
  }
  console.log('Generated types match the live API spec.');
} else {
  writeFileSync(OUT, next);
  console.log(`Wrote src/generated/schema.ts (${Object.keys(spec.paths).length} paths).`);
}
