#!/usr/bin/env node
/**
 * check-hr-kb-invariants.mjs
 *
 * Reconciles the knowledge base against the HR documents it points at, on real data. The application refuses to
 * link a personal document at four layers (the publish service, a database trigger, a read-time guard, and the
 * absence of any path that indexes an HR file), and each layer has its own tests. This is the check that asks the
 * DATABASE, after the fact, whether any layer was ever bypassed: a restore, a bulk update with triggers off, a
 * migration, a hand-run script, or a bug none of the tests imagined.
 *
 * It asserts, per organisation or across all of them:
 *   1. every ACTIVE link points at a document that is shareable right now (`app.hr_document_is_publishable`, the
 *      one database definition, migration 1201), and never at a Personal or Confidential document, a person's
 *      file, a non-company type, a hiring document, or a removed one;
 *   2. every audience row of an active link sits inside the document's own audiences;
 *   3. no KB attachment or KB source holds the storage key of an HR document or of one of its versions, and no
 *      chunk or ingestion checkpoint was derived from one that does;
 *   4. no KB attachment or source sits under a sensitive folder root (payroll, hr-documents, onboarding, ...);
 *   5. every chunk and checkpoint is of a kind the indexer writes.
 * It reports, without failing on them: withdrawn links whose document is no longer shareable (the expected state
 * after a reclassification; they are unreadable and carry no document detail), and active links whose document
 * row no longer exists (a hard delete; also unreadable).
 *
 * It is read-only: one READ ONLY transaction, no write, and it prints counts and opaque ids, never a file name or
 * a storage key (the key embeds the sanitised file name, which can itself be personal data).
 *
 * Usage:
 *   HR_KB_DATABASE_URL=postgresql://<table owner>@host/db node src/scripts/check-hr-kb-invariants.mjs [--org=<orgId>]
 *   node src/scripts/check-hr-kb-invariants.mjs --self-test
 *
 * Connect as a role that can read every tenant's rows (the table owner or a BYPASSRLS role). The gate sets
 * `row_security = off`, so a role that would be filtered fails loudly instead of reading a partial answer.
 * It scans the chunk table: run it off-peak or against a replica on a large database.
 *
 * Exit codes:
 *   0 every invariant holds · 1 a violation · 2 INCONCLUSIVE (a prerequisite is absent, or there is nothing to compare)
 */
import process from "node:process";

const SELF_TEST = process.argv.includes("--self-test");
const SAMPLE = 20;

/** Folder roots under which no KB attachment or source may sit; the same list as docs/hrms-kb/sql/pr1-kb-sensitive-attachments.sql. */
export const SENSITIVE_ROOTS = [
  "payroll", "payroll-exports", "payslips", "hr", "hr-documents", "hr-exports", "documents", "onboarding",
  "onboarding-docs", "resignations", "candidates", "candidate-vault", "esign", "e-sign", "signos", "signatures",
  "bank-batches", "gdpr-exports", "expense-exports", "fin-report-exports",
];
export const KNOWN_CHUNK_SOURCES = ["article_body", "attachment", "page_body", "source"];
export const KNOWN_CHECKPOINT_TYPES = ["page", "article", "source", "attachment"];

const HARD = [
  ["activeOnUnshareable", "an active link points at a document that is not shareable now"],
  ["audiencesOutsideDocument", "a link's audience is wider than its document's own"],
  ["attachmentsOfHrFiles", "a KB attachment holds the storage key of an HR document or version"],
  ["sourcesOfHrFiles", "a KB source holds the storage key of an HR document or version"],
  ["chunksOfHrFiles", "a chunk was derived from a KB attachment or source that holds an HR file"],
  ["checkpointsOfHrFiles", "an ingestion checkpoint was derived from a KB attachment or source that holds an HR file"],
  ["sensitiveAttachments", "a KB attachment sits under a sensitive folder root"],
  ["sensitiveSources", "a KB source sits under a sensitive folder root"],
];

/**
 * Turns what the queries found into a verdict. Pure, so the self-test can plant every class of violation and
 * assert the specific finding rather than a non-zero exit.
 *
 * Each fact is `{ total, sample }`. `counts.documents === 0` means there was nothing to compare, which is
 * INCONCLUSIVE and never a pass: every check below would hold vacuously.
 */
export function classify(facts) {
  const findings = [];
  for (const [key, meaning] of HARD) if ((facts[key]?.total ?? 0) > 0) findings.push({ key, meaning, total: facts[key].total, sample: facts[key].sample ?? [] });
  for (const row of facts.unknownChunkSources ?? []) findings.push({ key: "unknownChunkSource", meaning: `a chunk has a source the indexer does not write ("${row.value}")`, total: row.total, sample: [] });
  for (const row of facts.unknownCheckpointTypes ?? []) findings.push({ key: "unknownCheckpointType", meaning: `a checkpoint has a content type the indexer does not write ("${row.value}")`, total: row.total, sample: [] });

  const reconciled = (facts.counts?.activeOnShareable ?? 0) + (facts.activeOnUnshareable?.total ?? 0) + (facts.informational?.activeWithoutDocument ?? 0);
  if (facts.counts?.activeLinks !== undefined && facts.counts.activeLinks !== reconciled)
    findings.push({ key: "reconciliation", meaning: `the active links (${facts.counts.activeLinks}) do not add up to those on a shareable document, on one that is not, and on one that no longer exists (${reconciled})`, total: Math.abs(facts.counts.activeLinks - reconciled), sample: [] });

  if ((facts.counts?.documents ?? 0) === 0)
    return { verdict: "INCONCLUSIVE", why: "there are no HR documents in scope, so 'no personal document was linked' compares nothing", findings, exitCode: 2 };
  return { verdict: findings.length > 0 ? "VIOLATION" : "CLEAN", why: null, findings, exitCode: findings.length > 0 ? 1 : 0 };
}

function runSelfTest() {
  let passed = 0;
  const failures = [];
  const assert = (label, condition) => {
    if (condition) passed++;
    else failures.push(label);
  };
  const clean = () => ({
    counts: { documents: 40, links: 5, activeLinks: 4, activeOnShareable: 4 },
    informational: { withdrawnOnUnshareable: 0, activeWithoutDocument: 0 },
    activeOnUnshareable: { total: 0, sample: [] },
    audiencesOutsideDocument: { total: 0, sample: [] },
    attachmentsOfHrFiles: { total: 0, sample: [] },
    sourcesOfHrFiles: { total: 0, sample: [] },
    chunksOfHrFiles: { total: 0, sample: [] },
    checkpointsOfHrFiles: { total: 0, sample: [] },
    sensitiveAttachments: { total: 0, sample: [] },
    sensitiveSources: { total: 0, sample: [] },
    unknownChunkSources: [],
    unknownCheckpointTypes: [],
  });

  const control = classify(clean());
  assert("a database where every invariant holds is CLEAN", control.verdict === "CLEAN");
  assert("and exits 0", control.exitCode === 0);
  assert("and reports no finding", control.findings.length === 0);

  for (const [key] of HARD) {
    // A planted active-link violation is also two more active links, as it would be in a real database.
    const planted = { ...clean(), [key]: { total: 2, sample: ["org1:7"] } };
    if (key === "activeOnUnshareable") planted.counts = { ...planted.counts, activeLinks: planted.counts.activeLinks + 2 };
    const result = classify(planted);
    assert(`a planted ${key} is a VIOLATION`, result.verdict === "VIOLATION");
    assert(`${key} exits 1, a real finding, not 2`, result.exitCode === 1);
    assert(`${key} is named, with its count`, result.findings.length === 1 && result.findings[0].key === key && result.findings[0].total === 2);
    assert(`${key} keeps its sample ids`, result.findings[0]?.sample[0] === "org1:7");
  }

  const chunk = classify({ ...clean(), unknownChunkSources: [{ value: "hr_document", total: 3 }] });
  assert("a chunk with a source the indexer never writes is a VIOLATION", chunk.exitCode === 1 && chunk.findings[0]?.key === "unknownChunkSource");
  assert("and the source is named", (chunk.findings[0]?.meaning ?? "").includes("hr_document"));
  const checkpoint = classify({ ...clean(), unknownCheckpointTypes: [{ value: "hr", total: 1 }] });
  assert("a checkpoint of a type the indexer never writes is a VIOLATION", checkpoint.exitCode === 1 && checkpoint.findings[0]?.key === "unknownCheckpointType");

  const drift = classify({ ...clean(), counts: { documents: 40, links: 5, activeLinks: 5, activeOnShareable: 4 } });
  assert("active links that do not add up to their three parts are a VIOLATION", drift.exitCode === 1 && drift.findings[0]?.key === "reconciliation");
  const addsUp = classify({ ...clean(), counts: { documents: 40, links: 6, activeLinks: 6, activeOnShareable: 4 }, activeOnUnshareable: { total: 1, sample: ["o:1"] }, informational: { withdrawnOnUnshareable: 0, activeWithoutDocument: 1 } });
  assert("a violation and an orphan that account for every active link reconcile, so only the violation is reported", addsUp.findings.length === 1 && addsUp.findings[0].key === "activeOnUnshareable");

  const two = classify({ ...clean(), counts: { documents: 40, links: 6, activeLinks: 5, activeOnShareable: 4 }, activeOnUnshareable: { total: 1, sample: [] }, sensitiveSources: { total: 4, sample: [] } });
  assert("two violations are both reported, not the first only", two.findings.length === 2);

  const empty = classify({ ...clean(), counts: { documents: 0, links: 0, activeLinks: 0, activeOnShareable: 0 } });
  assert("a scope with no documents is INCONCLUSIVE, never CLEAN", empty.verdict === "INCONCLUSIVE");
  assert("and exits 2", empty.exitCode === 2);
  assert("and says why", (empty.why ?? "").includes("no HR documents"));
  const emptyButBroken = classify({ ...clean(), counts: { documents: 0, links: 1, activeLinks: 1, activeOnShareable: 0 }, informational: { withdrawnOnUnshareable: 0, activeWithoutDocument: 0 }, activeOnUnshareable: { total: 1, sample: [] } });
  assert("no documents with a dangling violation is still INCONCLUSIVE, with the finding kept", emptyButBroken.exitCode === 2 && emptyButBroken.findings.length === 1);

  assert("the sensitive-folder list is not empty, so that check cannot be vacuous", SENSITIVE_ROOTS.length > 10);
  assert("the sensitive-folder list carries the HR document folders", ["hr", "hr-documents", "documents", "payslips"].every((root) => SENSITIVE_ROOTS.includes(root)));
  assert("the known chunk sources are the four the schema declares", KNOWN_CHUNK_SOURCES.length === 4);

  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`  FAIL: ${f}\n`);
    process.stderr.write(`check-hr-kb-invariants self-tests: ${failures.length} failed, ${passed} passed\n`);
    process.exit(1);
  }
  process.stdout.write(`check-hr-kb-invariants self-tests: ${passed} passed\n`);
  process.exit(0);
}

if (SELF_TEST) runSelfTest();

function inconclusive(why) {
  process.stderr.write(`INCONCLUSIVE — ${why}\n`);
  process.exit(2);
}

/** Opaque ids only: an organisation prefix and a row id. */
const idOf = (row) => `${String(row.org_id).slice(0, 8)}:${row.id}`;

async function collect(sql, org) {
  const inOrg = (column) => (org === null ? sql`true` : sql`${sql(column)} = ${org}`);
  const facts = {};
  const sampled = async (rowsQuery, totalQuery) => {
    const [{ n }] = await totalQuery;
    const rows = await rowsQuery;
    return { total: Number(n), sample: rows.map(idOf) };
  };

  const hrKey = (table) => sql`(
    EXISTS (SELECT 1 FROM documents d WHERE d.org_id = ${sql(table)}.org_id AND d.file_url IS NOT NULL AND d.file_url = ${sql(table)}.file_key)
    OR EXISTS (SELECT 1 FROM document_versions v WHERE v.org_id = ${sql(table)}.org_id AND v.file_url IS NOT NULL AND v.file_url = ${sql(table)}.file_key)
  )`;

  const [counts] = await sql`
    SELECT (SELECT count(*) FROM organizations WHERE ${inOrg("id")})::int AS organizations,
           (SELECT count(*) FROM documents WHERE ${inOrg("org_id")})::int AS documents,
           (SELECT count(*) FROM documents WHERE classification IN ('PERSONAL','CONFIDENTIAL') AND ${inOrg("org_id")})::int AS "personalOrConfidential",
           (SELECT count(*) FROM kb_linked_documents WHERE ${inOrg("org_id")})::int AS links,
           (SELECT count(*) FROM kb_linked_documents WHERE status = 'active' AND ${inOrg("org_id")})::int AS "activeLinks",
           (SELECT count(*) FROM kb_linked_documents l JOIN documents d ON d.org_id = l.org_id AND d.id = l.document_id
             WHERE l.status = 'active' AND app.hr_document_is_publishable(d) AND ${inOrg("l.org_id")})::int AS "activeOnShareable"`;
  facts.counts = counts;

  const unshareable = sql`l.status = 'active' AND d.id IS NOT NULL AND NOT app.hr_document_is_publishable(d) AND ${inOrg("l.org_id")}`;
  facts.activeOnUnshareable = await sampled(
    sql`SELECT l.org_id, l.id FROM kb_linked_documents l JOIN documents d ON d.org_id = l.org_id AND d.id = l.document_id WHERE ${unshareable} ORDER BY l.org_id, l.id LIMIT ${SAMPLE}`,
    sql`SELECT count(*)::int AS n FROM kb_linked_documents l JOIN documents d ON d.org_id = l.org_id AND d.id = l.document_id WHERE ${unshareable}`,
  );
  facts.unshareableReasons = await sql`
    SELECT reason, count(*)::int AS total FROM (
      SELECT unnest(ARRAY_REMOVE(ARRAY[
        CASE WHEN NOT d.is_active THEN 'removed' END,
        CASE WHEN d.classification NOT IN ('INTERNAL','RESTRICTED') THEN 'classification is ' || lower(d.classification::text) END,
        CASE WHEN d.type NOT IN ('POLICY','OTHER') THEN 'type is ' || lower(d.type::text) END,
        CASE WHEN d.user_id IS NOT NULL AND d.user_id IS DISTINCT FROM d.uploaded_by THEN 'belongs to a person' END,
        CASE WHEN coalesce(d.metadata, '{}'::jsonb) ?| ARRAY['candidateId','offerId'] THEN 'came from hiring' END
      ], NULL)) AS reason
      FROM kb_linked_documents l JOIN documents d ON d.org_id = l.org_id AND d.id = l.document_id WHERE ${unshareable}
    ) r GROUP BY reason ORDER BY total DESC`;

  const [informational] = await sql`
    SELECT (SELECT count(*) FROM kb_linked_documents l JOIN documents d ON d.org_id = l.org_id AND d.id = l.document_id
             WHERE l.status <> 'active' AND NOT app.hr_document_is_publishable(d) AND ${inOrg("l.org_id")})::int AS "withdrawnOnUnshareable",
           (SELECT count(*) FROM kb_linked_documents l WHERE l.status = 'active' AND l.document_id IS NULL AND ${inOrg("l.org_id")})::int AS "activeWithoutDocument"`;
  facts.informational = informational;

  const outside = sql`${inOrg("a.org_id")} AND NOT EXISTS (
    SELECT 1 FROM document_audiences c
    WHERE c.org_id = a.org_id AND c.document_id = l.document_id
      AND (c.kind = 'ALL_EMPLOYEES' OR (c.kind = a.kind AND coalesce(c.ref_id, '') = coalesce(a.ref_id, ''))))`;
  facts.audiencesOutsideDocument = await sampled(
    sql`SELECT a.org_id, a.linked_document_id AS id FROM kb_linked_document_audiences a JOIN kb_linked_documents l ON l.org_id = a.org_id AND l.id = a.linked_document_id AND l.status = 'active' AND l.document_id IS NOT NULL WHERE ${outside} ORDER BY a.org_id, a.id LIMIT ${SAMPLE}`,
    sql`SELECT count(*)::int AS n FROM kb_linked_document_audiences a JOIN kb_linked_documents l ON l.org_id = a.org_id AND l.id = a.linked_document_id AND l.status = 'active' AND l.document_id IS NOT NULL WHERE ${outside}`,
  );

  const attachmentsHoldingHr = sql`${inOrg("t.org_id")} AND ${hrKey("t")}`;
  facts.attachmentsOfHrFiles = await sampled(
    sql`SELECT t.org_id, t.id FROM kb_page_attachments t WHERE ${attachmentsHoldingHr} ORDER BY t.org_id, t.id LIMIT ${SAMPLE}`,
    sql`SELECT count(*)::int AS n FROM kb_page_attachments t WHERE ${attachmentsHoldingHr}`,
  );
  const sourcesHoldingHr = sql`${inOrg("t.org_id")} AND (${hrKey("t")} OR (t.file_url IS NOT NULL AND (
    EXISTS (SELECT 1 FROM documents d WHERE d.org_id = t.org_id AND d.file_url = t.file_url)
    OR EXISTS (SELECT 1 FROM document_versions v WHERE v.org_id = t.org_id AND v.file_url = t.file_url))))`;
  facts.sourcesOfHrFiles = await sampled(
    sql`SELECT t.org_id, t.id FROM kb_sources t WHERE ${sourcesHoldingHr} ORDER BY t.org_id, t.id LIMIT ${SAMPLE}`,
    sql`SELECT count(*)::int AS n FROM kb_sources t WHERE ${sourcesHoldingHr}`,
  );

  const derived = sql`${inOrg("c.org_id")} AND (
    (c.attachment_id IS NOT NULL AND EXISTS (SELECT 1 FROM kb_page_attachments t WHERE t.org_id = c.org_id AND t.id = c.attachment_id AND ${hrKey("t")}))
    OR (c.source_id IS NOT NULL AND EXISTS (SELECT 1 FROM kb_sources t WHERE t.org_id = c.org_id AND t.id = c.source_id AND (${hrKey("t")} OR (t.file_url IS NOT NULL AND EXISTS (SELECT 1 FROM documents d WHERE d.org_id = t.org_id AND d.file_url = t.file_url))))))`;
  facts.chunksOfHrFiles = await sampled(
    sql`SELECT c.org_id, c.id FROM kb_article_chunks c WHERE ${derived} ORDER BY c.org_id, c.id LIMIT ${SAMPLE}`,
    sql`SELECT count(*)::int AS n FROM kb_article_chunks c WHERE ${derived}`,
  );
  const checkpointsDerived = sql`${inOrg("k.org_id")} AND (
    (k.content_type = 'attachment' AND EXISTS (SELECT 1 FROM kb_page_attachments t WHERE t.org_id = k.org_id AND t.id = k.content_id AND ${hrKey("t")}))
    OR (k.content_type = 'source' AND EXISTS (SELECT 1 FROM kb_sources t WHERE t.org_id = k.org_id AND t.id = k.content_id AND ${hrKey("t")})))`;
  facts.checkpointsOfHrFiles = await sampled(
    sql`SELECT k.org_id, k.id FROM kb_ingestion_checkpoints k WHERE ${checkpointsDerived} ORDER BY k.org_id, k.id LIMIT ${SAMPLE}`,
    sql`SELECT count(*)::int AS n FROM kb_ingestion_checkpoints k WHERE ${checkpointsDerived}`,
  );

  const underRoot = (table) => sql`(
    lower(split_part(${sql(table)}.file_key, '/', 1)) IN ${sql(SENSITIVE_ROOTS)}
    OR lower(split_part(${sql(table)}.file_key, '/', 2)) IN ${sql(SENSITIVE_ROOTS)}
    OR lower(split_part(${sql(table)}.file_key, '/', 3)) IN ${sql(SENSITIVE_ROOTS)})`;
  facts.sensitiveAttachments = await sampled(
    sql`SELECT t.org_id, t.id FROM kb_page_attachments t WHERE ${inOrg("t.org_id")} AND ${underRoot("t")} ORDER BY t.org_id, t.id LIMIT ${SAMPLE}`,
    sql`SELECT count(*)::int AS n FROM kb_page_attachments t WHERE ${inOrg("t.org_id")} AND ${underRoot("t")}`,
  );
  facts.sensitiveSources = await sampled(
    sql`SELECT t.org_id, t.id FROM kb_sources t WHERE ${inOrg("t.org_id")} AND t.file_key IS NOT NULL AND ${underRoot("t")} ORDER BY t.org_id, t.id LIMIT ${SAMPLE}`,
    sql`SELECT count(*)::int AS n FROM kb_sources t WHERE ${inOrg("t.org_id")} AND t.file_key IS NOT NULL AND ${underRoot("t")}`,
  );

  facts.unknownChunkSources = (
    await sql`SELECT c.source AS value, count(*)::int AS total FROM kb_article_chunks c WHERE ${inOrg("c.org_id")} AND c.source NOT IN ${sql(KNOWN_CHUNK_SOURCES)} GROUP BY c.source`
  ).map((row) => ({ value: row.value, total: row.total }));
  facts.unknownCheckpointTypes = (
    await sql`SELECT k.content_type AS value, count(*)::int AS total FROM kb_ingestion_checkpoints k WHERE ${inOrg("k.org_id")} AND k.content_type NOT IN ${sql(KNOWN_CHECKPOINT_TYPES)} GROUP BY k.content_type`
  ).map((row) => ({ value: row.value, total: row.total }));
  return facts;
}

const url = process.env.HR_KB_DATABASE_URL;
if (!url) inconclusive("HR_KB_DATABASE_URL is required; nothing was compared.");
const orgArg = process.argv.find((arg) => arg.startsWith("--org="));
const org = orgArg ? orgArg.slice("--org=".length) : null;
if (orgArg && !org) inconclusive("--org= needs an organisation id.");

const { createScriptSql } = await import("./lib/script-sql-client.mjs");
const sql = await createScriptSql({ url, connection: { prepare: false, max: 1, onnotice: () => {}, connect_timeout: 60 } });
let exitCode;
try {
  let facts;
  try {
    facts = await sql.begin("isolation level repeatable read, read only", async (tx) => {
      await tx`SET LOCAL statement_timeout = '300s'`;
      await tx`SET LOCAL row_security = off`;
      const [present] = await tx`
        SELECT to_regclass('public.kb_linked_documents') IS NOT NULL AS links,
               to_regclass('public.kb_linked_document_audiences') IS NOT NULL AS audiences,
               to_regclass('public.document_audiences') IS NOT NULL AS document_audiences,
               to_regprocedure('app.hr_document_is_publishable(public.documents)') IS NOT NULL AS fn`;
      if (!present.links || !present.audiences || !present.document_audiences || !present.fn)
        return { missing: `the HRMS-KB schema is not fully applied here (linked documents: ${present.links}, link audiences: ${present.audiences}, document audiences: ${present.document_audiences}, shareable function: ${present.fn}); migrations 1199-1201 are the prerequisite` };
      // A row-level policy that would filter this role raises instead of returning a partial answer.
      await tx`SELECT count(*) FROM kb_linked_documents`;
      await tx`SELECT count(*) FROM documents`;
      return collect(tx, org);
    });
  } catch (error) {
    inconclusive(`the database could not be read as this role, so no comparison was made: ${String(error)}`);
  }
  if (facts.missing) inconclusive(facts.missing);

  const result = classify(facts);
  const c = facts.counts;
  process.stdout.write(`Scope: ${org === null ? "every organisation" : `organisation ${org.slice(0, 8)}…`} (${c.organizations} in scope)\n`);
  process.stdout.write(`HR documents: ${c.documents} (${c.personalOrConfidential} Personal or Confidential)\n`);
  process.stdout.write(`Knowledge-base links: ${c.links} (${c.activeLinks} active)\n`);
  const bad = facts.activeOnUnshareable.total;
  process.stdout.write(`Reconciliation: ${c.activeLinks} active links = ${c.activeOnShareable} on a shareable document + ${bad} on a document that is not + ${facts.informational.activeWithoutDocument} on a document that no longer exists\n`);
  process.stdout.write(`Withdrawn links whose document is no longer shareable: ${facts.informational.withdrawnOnUnshareable} (expected after a reclassification; unreadable and carrying no document detail)\n`);
  if (facts.informational.activeWithoutDocument > 0)
    process.stdout.write(`Active links whose document row no longer exists: ${facts.informational.activeWithoutDocument} (a hard delete; unreadable)\n`);
  if (facts.unshareableReasons.length > 0) {
    process.stdout.write("Why the violating active links are not shareable:\n");
    for (const row of facts.unshareableReasons) process.stdout.write(`  ${row.total}  ${row.reason}\n`);
  }
  for (const finding of result.findings) {
    process.stdout.write(`VIOLATION  ${finding.total}  ${finding.meaning}\n`);
    if (finding.sample.length > 0) process.stdout.write(`           e.g. ${finding.sample.join(", ")}\n`);
  }
  process.stdout.write(`HR-KB INVARIANTS: ${result.verdict}\n`);
  if (result.why !== null) process.stderr.write(`  ${result.why}\n`);
  exitCode = result.exitCode;
} finally {
  await sql.end();
}
process.exitCode = exitCode;
