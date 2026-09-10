import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// load env
//
// THREE levels up, not four. From src/scripts/__tests__ that is the repository
// root, which is where .env actually lives. It read '../../../..' — the
// workspace PARENT, where there is no .env and never was — so this script never
// once loaded its own configuration. It fell through to process.env.DATABASE_URL,
// found nothing, handed undefined to postgres() and got libpq's localhost
// defaults, which failed ECONNRESET and was reported as a broken migration chain.
const envPath = resolve(import.meta.dirname, '../../..', '.env');
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

const JOURNAL_MAX = 1787941689254n;

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

/**
 * No database is a prerequisite failure, not a chain defect.
 *
 * This asserts that drizzle.__drizzle_migrations holds no row above the journal
 * maximum. With no DATABASE_URL it used to hand `undefined` to postgres() and
 * die on ECONNRESET with exit 1 — the same code it uses to say the chain IS
 * broken, so a sweep counted an unreachable database as orphaned migration rows.
 */
if (!DATABASE_URL) {
  console.error('PREREQUISITE MISSING: DATABASE_URL is not set, so the migration');
  console.error('ledger cannot be read. Set it in .env or the environment, then re-run.');
  process.exit(2);
}

const sql = postgres(DATABASE_URL, { prepare: false, max: 1, ssl: 'require' });
try {
  const orphanRows = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations WHERE created_at > ${JOURNAL_MAX}`;
  console.log('Before fix: orphan rows above journal max:', orphanRows[0].n);
  assert('orphan rows above journal max should be 0 (post-fix)', orphanRows[0].n, 0);

  const [dbMax] = await sql`SELECT max(created_at) AS mx FROM drizzle.__drizzle_migrations`;
  console.log('DB watermark:', dbMax.mx?.toString());
  
  const totalRows = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
  console.log('Total DB rows:', totalRows[0].n);

} catch (e) {
  // A connection that cannot be opened is the same prerequisite failure as no
  // URL at all — the chain is not being reported on, so it must not be reported
  // as broken.
  const code = e && typeof e === 'object' ? e.code : undefined;
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'CONNECT_TIMEOUT'].includes(code)) {
    console.error(`PREREQUISITE MISSING: cannot reach the database (${code}).`);
    await sql.end().catch(() => {});
    process.exit(2);
  }
  throw e;
} finally {
  await sql.end();
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
