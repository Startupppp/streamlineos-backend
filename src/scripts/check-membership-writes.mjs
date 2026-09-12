// node src/scripts/check-membership-writes.mjs [--self-test|--list] — 0 clean · 1 violation · 2 broken scan
//
// `organization_members` carries authorization state that JwtAuthGuard reads on every request
// through a 15-second cache. A write that lands without the matching invalidation leaves a
// revoked member reading as active until the TTL expires, and nothing fails. So the write and
// the invalidation are one operation, owned by `common/org/membership-mutations.ts`, and this
// gate is what stops a second writer appearing beside it.
//
// Three defect shapes, all of which existed before the owner did:
//   1. a Drizzle insert/update/delete on `organizationMembers` outside the owner
//   2. raw SQL DML on `organization_members` outside the owner
//   3. an import of an invalidation PRIMITIVE, which schedules a bust without naming the write
//      that earned it — the exact shape that let a caller bust for one change and forget another
//
// Exemptions are per file with a reason. A blanket directory skip is not an exemption, it is a
// hole, and the two classes below are enumerated by path for that reason.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUN_DIRECTLY =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const SRC_DIR = join(BACKEND_ROOT, "src");

const OWNER_WRITES = "src/common/org/membership-mutations.ts";
const OWNER_INVALIDATION = "src/common/org/membership-bust.ts";
const PRIMITIVE_DECLARATION = "src/common/auth/membership-state.service.ts";

const MIN_FILES = 500;
const MIN_OWNER_WRITES = 8;

/** file -> why it may write `organization_members` without the owner. */
export const WRITE_EXEMPT = new Map([
  [OWNER_WRITES, "the owner itself"],
  [
    "src/scripts/seed-demo.ts",
    "fixture seeding against a scratch database with no cache and no request",
  ],
  [
    "src/scripts/seed-enterprise-workspace.ts",
    "fixture seeding against a scratch database with no cache and no request",
  ],
  [
    "src/scripts/retention-drill-runner.ts",
    "retention drill plants and reads its own rows; going through the owner would bust a cache no drill reads",
  ],
  [
    "src/scripts/retention-drill-fixtures.ts",
    "retention drill teardown of its own planted rows",
  ],
  [
    "src/scripts/verify-membership-revocation.ts",
    "the live-database probe for revocation; it must write the row the app would write and then observe the cache itself",
  ],
  [
    "src/test/db-spec-fixture.ts",
    "the .db.spec tier's own floor: two fixed organisations planted idempotently in a scratch database before any suite runs. There is no cache to invalidate and no request to serve, and the file deliberately holds no Drizzle schema import — pulling the barrel in would drag the Nest module graph into a fixture whose whole job is to be cheap to load, which is the reason it is raw SQL and the reason the owner is unreachable from it",
  ],
  [
    // OWNERSHIP EXEMPTION, NOT A DESIGN EXEMPTION. Every other entry in this map says
    // "the owner is the wrong tool here". This one does not: the write is a genuine
    // second writer and it should go through the owner. It is exempted because the file
    // belongs to the HR developer and `src/modules/hr/` is fenced off from this branch,
    // so this branch may not author the change — not because the gate is wrong about it.
    //
    // What the write is. `OnboardingSubmissionService.submit` runs one transaction that
    // finishes a new joiner's onboarding, and at line 51 it stamps the membership row
    // directly:
    //
    //   await tx.update(organizationMembers)
    //     .set({ onboardingCompletedAt: completedAt })
    //     .where(eq(organizationMembers.id, membership.id));
    //
    // It is a narrow write — one non-authorization column, on a row the same transaction
    // has already SELECT … FOR UPDATE'd inside an advisory lock — and the method does
    // invalidate `CACHE_KEYS.userSession(userId)` afterwards. That is why this has not
    // produced a visible incident. It is still the shape this gate exists to stop: the
    // invalidation is a separate statement after the transaction rather than part of the
    // write, it busts the session key and not the membership-status cache JwtAuthGuard
    // reads, and nothing ties the two together if either side is edited later.
    //
    // What the owner must do with it. Move the stamp onto a `MembershipMutations` method
    // (an onboarding-completion mutation alongside the existing status writers) and call
    // it inside `withMembershipMutations(cache, ...)`, passing the request transaction, so
    // the write and its invalidation are one operation and this entry can be deleted. The
    // surrounding lock and FOR UPDATE stay as they are; only the update statement moves.
    //
    // Until then this is recorded debt with a named owner, not a blessing — and it is
    // spelled as a file exemption rather than a directory skip so that a SECOND write
    // appearing anywhere else under src/modules/hr/ still fails this gate.
    "src/modules/hr/onboarding/core/onboarding-submission.service.ts",
    "owned by the HR developer and fenced off from this branch, which may not edit src/modules/hr/. The write is real and not excused on its merits: `submit` stamps organizationMembers.onboardingCompletedAt directly at line 51 and invalidates only the user-session key afterwards, so the write and its invalidation are two operations rather than one. It must be migrated to a MembershipMutations method called inside withMembershipMutations(cache, ...) by that owner, after which this entry is deleted",
  ],
]);

/** file -> why it may import an invalidation primitive. */
export const PRIMITIVE_EXEMPT = new Map([
  [OWNER_WRITES, "the owner itself"],
  [OWNER_INVALIDATION, "the invalidation half of the owner"],
  [PRIMITIVE_DECLARATION, "declares bustMembershipStatusCache and bustMembershipStatusCacheMany"],
]);

const PRIMITIVES = [
  "scheduleMembershipBust",
  "scheduleMembershipBustMany",
  "bustMembershipNowAndAfterCommit",
  "bustMembershipStatusCache",
  "bustMembershipStatusCacheMany",
];

const DRIZZLE_WRITE_RE = /\.(insert|update|delete)\(\s*organizationMembers\b/g;
const RAW_WRITE_RE =
  /\b(?:insert\s+into|update|delete\s+from)\s+["`]?organization_members\b/gi;
const CONSTRUCT_RE = /\bnew\s+MembershipMutations\s*\(/g;

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

function matchesWith(source, re) {
  const out = [];
  re.lastIndex = 0;
  for (const match of source.matchAll(re))
    out.push({ line: lineOf(source, match.index ?? 0), text: match[0].replace(/\s+/g, " ") });
  return out;
}

export function findDrizzleWrites(source) {
  return matchesWith(source, DRIZZLE_WRITE_RE);
}

export function findRawWrites(source) {
  return matchesWith(source, RAW_WRITE_RE);
}

export function findConstructions(source) {
  return matchesWith(source, CONSTRUCT_RE);
}

/**
 * Only import statements count. A method named `scheduleMembershipBust` on the owner, or the
 * word inside a message, is not a second writer reaching for the primitive.
 */
export function findPrimitiveImports(source) {
  const out = [];
  const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(importRe)) {
    const clause = match[1] ?? "";
    for (const primitive of PRIMITIVES) {
      if (!new RegExp(`\\b${primitive}\\b`).test(clause)) continue;
      out.push({
        line: lineOf(source, match.index ?? 0),
        text: `${primitive} from "${match[2] ?? ""}"`,
      });
    }
  }
  return out;
}

function walkTs(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkTs(full, out);
      continue;
    }
    if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".d.ts") &&
      !entry.endsWith(".spec.ts") &&
      !entry.endsWith(".e2e-spec.ts")
    )
      out.push(full);
  }
  return out;
}

if (RUN_DIRECTLY && process.argv.includes("--self-test")) {
  const failures = [];
  const check = (label, actual, expected) => {
    if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
  };

  check(
    "single-line drizzle insert",
    findDrizzleWrites("await tx.insert(organizationMembers).values(x);").length,
    1,
  );
  check(
    "line-wrapped drizzle update",
    findDrizzleWrites("await tx\n  .update(\n    organizationMembers,\n  )\n  .set(y);").length,
    1,
  );
  check(
    "drizzle delete",
    findDrizzleWrites("await tx.delete(organizationMembers).where(w);").length,
    1,
  );
  check(
    "a read is not a write",
    findDrizzleWrites("await tx.select().from(organizationMembers).where(w);").length,
    0,
  );
  check(
    "a lookalike table is not this table",
    findDrizzleWrites("await tx.insert(organizationMembersArchive).values(x);").length,
    0,
  );

  check(
    "raw insert",
    findRawWrites("await sql`INSERT INTO organization_members (user_id) VALUES (${id})`;").length,
    1,
  );
  check(
    "raw update",
    findRawWrites("await sql`update organization_members set status = 'LEFT'`;").length,
    1,
  );
  check(
    "raw delete",
    findRawWrites("await sql`DELETE FROM organization_members WHERE org_id = ${o}`;").length,
    1,
  );
  check(
    "raw select is not a write",
    findRawWrites("await sql`SELECT id FROM organization_members`;").length,
    0,
  );
  check(
    "sequence allocation is not a write",
    findRawWrites("sql`SELECT nextval(pg_get_serial_sequence('organization_members', 'id'))`").length,
    0,
  );

  check(
    "primitive import",
    findPrimitiveImports('import { scheduleMembershipBust } from "../org/membership-bust";').length,
    1,
  );
  check(
    "multi-name primitive import",
    findPrimitiveImports(
      'import {\n  bustMembershipStatusCache,\n  bustMembershipStatusCacheMany,\n} from "./membership-state.service";',
    ).length,
    2,
  );
  check(
    "operation import is allowed",
    findPrimitiveImports(
      'import { bustMembershipsAfterOrgTeardown } from "../org/membership-bust";',
    ).length,
    0,
  );
  check(
    "a method call is not an import",
    findPrimitiveImports("await scheduleMembershipBust(cache, id, orgId);").length,
    0,
  );

  check(
    "direct construction",
    findConstructions("const m = new MembershipMutations();").length,
    1,
  );
  check(
    "the wrapper is not a construction",
    findConstructions("await withMembershipMutations(cache, (m) => run(m));").length,
    0,
  );

  if (failures.length > 0) {
    console.error("SELF-TEST FAILED:");
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(2);
  }
  console.log(
    "SELF-TEST OK — drizzle writes, raw DML, primitive imports and direct construction are told apart from reads, operations and lookalikes.",
  );
  process.exit(0);
}

function scanRepository() {
  const files = walkTs(SRC_DIR);
  if (files.length < MIN_FILES) {
    console.error(
      `Walked only ${files.length} TypeScript files. That is a broken walker, not a small codebase.`,
    );
    process.exit(2);
  }

  const violations = [];
  let ownerWrites = 0;
  let scanned = 0;

  for (const file of files) {
    const rel = relative(BACKEND_ROOT, file).replace(/\\/g, "/");
    const source = readFileSync(file, "utf8");
    scanned += 1;

    const writes = [...findDrizzleWrites(source), ...findRawWrites(source)];
    if (rel === OWNER_WRITES) ownerWrites = writes.length;

    if (!WRITE_EXEMPT.has(rel))
      for (const hit of writes)
        violations.push({
          rel,
          line: hit.line,
          kind: "DIRECT MEMBERSHIP WRITE",
          text: hit.text,
          fix: "Use a MembershipMutations method inside withMembershipMutations(cache, ...) — the write and its invalidation are one operation.",
        });

    if (!PRIMITIVE_EXEMPT.has(rel))
      for (const hit of findPrimitiveImports(source))
        violations.push({
          rel,
          line: hit.line,
          kind: "PRIVATE INVALIDATION PRIMITIVE",
          text: hit.text,
          fix: "Use a named operation: a MembershipMutations method, or revokeMembershipAccessCaches / bustMembershipsAfterOrgTeardown / bustMembershipAfterIdentityErasure / bustMembershipAfterOwnershipChange.",
        });

    if (rel !== OWNER_WRITES)
      for (const hit of findConstructions(source))
        violations.push({
          rel,
          line: hit.line,
          kind: "UNDRAINED MUTATOR",
          text: hit.text,
          fix: "Only withMembershipMutations may construct one; a hand-built mutator records invalidations nobody drains.",
        });
  }

  if (ownerWrites < MIN_OWNER_WRITES) {
    console.error(
      `Found ${ownerWrites} membership write(s) in ${OWNER_WRITES}, expected at least ${MIN_OWNER_WRITES}. The matcher is broken, or the owner was gutted.`,
    );
    process.exit(2);
  }

  console.log(`production files scanned  ${scanned}`);
  console.log(`writes inside the owner   ${ownerWrites}`);

  if (process.argv.includes("--list")) {
    for (const [rel, why] of WRITE_EXEMPT) console.log(`  WRITE EXEMPT      ${rel} — ${why}`);
    for (const [rel, why] of PRIMITIVE_EXEMPT) console.log(`  PRIMITIVE EXEMPT  ${rel} — ${why}`);
    process.exit(0);
  }

  console.log(
    `exemptions                ${WRITE_EXEMPT.size} write, ${PRIMITIVE_EXEMPT.size} primitive`,
  );
  for (const [rel, why] of WRITE_EXEMPT) console.log(`  SKIP  ${rel} — ${why}`);
  console.log("");

  if (violations.length === 0) {
    console.log(
      "OK — every organization-membership write goes through common/org/membership-mutations.ts.",
    );
    process.exit(0);
  }

  for (const violation of violations)
    console.error(
      `  ${violation.kind}  ${violation.rel}:${violation.line}  ${violation.text}
    ${violation.fix}`,
    );
  console.error("");
  console.error(`FAIL — ${violations.length} membership-write violation(s).`);
  process.exit(1);
}

if (RUN_DIRECTLY) scanRepository();
