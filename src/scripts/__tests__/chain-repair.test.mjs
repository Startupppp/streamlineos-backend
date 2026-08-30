import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// load env
const envPath = resolve(import.meta.dirname, '../../../..', '.env');
let DATABASE_URL;
try {
  const envFile = readFileSync(envPath, 'utf8');
  for (const line of envFile.split('\n')) {
    if (line.startsWith('DATABASE_URL=')) {
      DATABASE_URL = line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '');
    }
  }
} catch {}
DATABASE_URL = DATABASE_URL || process.env.DATABASE_URL;

const JOURNAL_MAX = 1787941388254n;

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  if (actual === expected || JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

console.log('Chain repair test: verify orphan rows and journal state\n');

const sql = postgres(DATABASE_URL, { prepare: false, max: 1, ssl: 'require' });
try {
  const orphanRows = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations WHERE created_at > ${JOURNAL_MAX}`;
  console.log('Before fix: orphan rows above journal max:', orphanRows[0].n);
  assert('orphan rows above journal max should be 0 (post-fix)', orphanRows[0].n, 0);

  const [dbMax] = await sql`SELECT max(created_at) AS mx FROM drizzle.__drizzle_migrations`;
  console.log('DB watermark:', dbMax.mx?.toString());
  
  const totalRows = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
  console.log('Total DB rows:', totalRows[0].n);

} finally {
  await sql.end();
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
