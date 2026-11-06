import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePolicy } from '../src/policy.js';
import { SAMPLE_POLICY } from '../src/policy.fixture.js';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../../contracts/test/fixtures/policy.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ encoded: encodePolicy(SAMPLE_POLICY) }, null, 2) + '\n');
console.log(`wrote ${out}`);
