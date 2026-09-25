/**
 * HRMS-KB PR 8 — the reconciliation gate, run for real against a real database.
 *
 * `check-hr-kb-invariants.mjs` is a script, so this runs the script: a clean organisation must pass, and each way a
 * personal document could have reached the knowledge base (an active link on a document that stopped being
 * shareable, a link wider than its document, an HR file registered as a KB attachment or source, a chunk derived
 * from one, a sensitive folder, a chunk or checkpoint of a kind the indexer never writes) is planted in its own
 * organisation and must be named, with exit 1. An organisation with no documents, and a missing connection string,
 * must be INCONCLUSIVE (exit 2), never a pass. A gate that has only ever been shown clean data proves nothing.
 *
 * Run with:
 *   DATABASE_URL=postgres://user@localhost:5432/scratch_… ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     npx jest --config ./jest-db.json --runInBand --testPathPattern=check-hr-kb-invariants
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { dbSpecClient, dbSpecSuite } from "../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../test/db-spec-guard";
import { HrmsKbSeed, member, type SeededOrg } from "../test/hrms-kb-seed.spec-fixtures";

const describeDb = dbSpecSuite();
const run = promisify(execFile);
const SCRIPT = path.resolve(__dirname, "check-hr-kb-invariants.mjs");
const ZERO_VECTOR = `[${new Array<number>(1536).fill(0).join(",")}]`;

interface Outcome {
  code: number;
  out: string;
  err: string;
}

describeDb("check:hr-kb-invariants against a real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({ spec: "check-hr-kb-invariants.db.spec.ts", vars: ["DATABASE_URL", "APP_DATABASE_URL"] })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let seed: HrmsKbSeed;

  beforeAll(() => {
    sql = dbSpecClient(raw, { max: 4 });
    seed = new HrmsKbSeed(sql);
  });

  afterAll(async () => {
    if (!sql) return;
    await seed.dispose();
    await sql.end({ timeout: 5 });
  }, 120_000);

  async function gate(org: SeededOrg | null, env: Record<string, string> = { HR_KB_DATABASE_URL: raw }): Promise<Outcome> {
    try {
      const { stdout, stderr } = await run(process.execPath, [SCRIPT, ...(org ? [`--org=${org.orgId}`] : [])], {
        env: { PATH: process.env.PATH ?? "", ...env },
        timeout: 120_000,
      });
      return { code: 0, out: stdout, err: stderr };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && "stdout" in error && "stderr" in error)
        return { code: Number(error.code), out: String(error.stdout), err: String(error.stderr) };
      throw error;
    }
  }

  async function org(label: string): Promise<SeededOrg> {
    return seed.org(`gate-${label}`, ["hr", "employee"]);
  }

  async function document(o: SeededOrg, over: { classification?: string; type?: string; name?: string } = {}): Promise<{ id: number; fileKey: string }> {
    const fileKey = `${o.orgId}/hr-documents/${randomUUID()}.pdf`;
    const [row] = await sql`
      insert into documents (org_id, uploaded_by, name, type, classification, file_url)
      values (${o.orgId}, ${member(o, "hr").id}, ${over.name ?? `gate-${randomUUID().slice(0, 8)}`}, ${over.type ?? "POLICY"}, ${over.classification ?? "INTERNAL"}, ${fileKey})
      returning id`;
    const id = Number(row?.id);
    await sql`insert into document_audiences (org_id, document_id, kind, ref_id) values (${o.orgId}, ${id}, 'ALL_EMPLOYEES', null)`;
    return { id, fileKey };
  }

  async function link(o: SeededOrg, documentId: number): Promise<number> {
    const [row] = await sql`insert into kb_linked_documents (org_id, document_id) values (${o.orgId}, ${documentId}) returning id`;
    const id = Number(row?.id);
    await sql`insert into kb_linked_document_audiences (org_id, linked_document_id, kind, ref_id) values (${o.orgId}, ${id}, 'ALL_EMPLOYEES', null)`;
    return id;
  }

  async function attachment(o: SeededOrg, fileKey: string): Promise<number> {
    const [row] = await sql`insert into kb_page_attachments (org_id, file_key, file_name, mime_type, file_size) values (${o.orgId}, ${fileKey}, 'x.pdf', 'application/pdf', 10) returning id`;
    return Number(row?.id);
  }

  // A cold-built database has this FK pointing at the legacy kb_article_attachments table, while the code writes
  // kb_page_attachments. The chunk is planted with foreign-key triggers off for this one insert, as a bulk load would.
  async function chunk(o: SeededOrg, values: { source: string; attachmentId?: number; sourceId?: number }): Promise<void> {
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`
        insert into kb_article_chunks (org_id, attachment_id, source_id, source, chunk_index, content, embedding, embedding_model)
        values (${o.orgId}, ${values.attachmentId ?? null}, ${values.sourceId ?? null}, ${values.source}, 0, 'text', ${ZERO_VECTOR}::vector, 'test')`;
    });
  }

  const finding = (out: string, text: string) => out.split("\n").some((line) => line.startsWith("VIOLATION") && line.includes(text));

  it("passes a clean organisation: a shared policy, and a Personal document and a payslip that were never linked", async () => {
    const o = await org("clean");
    const policy = await document(o);
    await link(o, policy.id);
    await document(o, { classification: "PERSONAL", name: "someone's file" });
    await document(o, { type: "PAYSLIP", classification: "PERSONAL" });

    const result = await gate(o);

    expect(result.code).toBe(0);
    expect(result.out).toContain("HR-KB INVARIANTS: CLEAN");
    expect(result.out).toContain("Reconciliation: 1 active links = 1 on a shareable document + 0 on a document that is not + 0 on a document that no longer exists");
    expect(result.out).not.toContain("VIOLATION");
  }, 60_000);

  it("never prints a file name or a storage key", async () => {
    const o = await org("privacy");
    const policy = await document(o, { name: "Distinctive Personal Name Handbook" });
    await link(o, policy.id);
    await attachment(o, policy.fileKey);

    const result = await gate(o);

    expect(result.code).toBe(1);
    expect(result.out + result.err).not.toContain("Distinctive Personal Name");
    expect(result.out + result.err).not.toContain("hr-documents");
    expect(result.out + result.err).not.toContain(".pdf");
  }, 60_000);

  it("names an active link left on a document that has since become Personal, with the reason", async () => {
    const o = await org("stale-link");
    const policy = await document(o);
    await link(o, policy.id);
    await sql.begin(async (tx) => {
      await tx`alter table documents disable trigger trg_documents_unlink_when_unpublishable`;
      try {
        await tx`update documents set classification = 'PERSONAL' where org_id = ${o.orgId} and id = ${policy.id}`;
      } finally {
        await tx`alter table documents enable trigger trg_documents_unlink_when_unpublishable`;
      }
    });

    const result = await gate(o);

    expect(result.code).toBe(1);
    expect(finding(result.out, "an active link points at a document that is not shareable now")).toBe(true);
    expect(result.out).toContain("classification is personal");
    expect(result.out).toContain("Reconciliation: 1 active links = 0 on a shareable document + 1 on a document that is not");
  }, 60_000);

  it("does not call a properly withdrawn link a violation, though its document is now Personal", async () => {
    const o = await org("withdrawn");
    const policy = await document(o);
    await link(o, policy.id);
    await sql`update documents set classification = 'PERSONAL' where org_id = ${o.orgId} and id = ${policy.id}`;

    const result = await gate(o);

    expect(result.code).toBe(0);
    expect(result.out).toContain("Withdrawn links whose document is no longer shareable: 1");
  }, 60_000);

  it("names a link whose audience is wider than its document's own", async () => {
    const o = await org("wider");
    const policy = await document(o);
    await sql`delete from document_audiences where org_id = ${o.orgId} and document_id = ${policy.id}`;
    const [unit] = await sql`insert into org_units (id, org_id, kind, name, code) values (${randomUUID()}, ${o.orgId}, 'DEPARTMENT', 'Dept', ${randomUUID().slice(0, 8)}) returning id`;
    await sql`insert into document_audiences (org_id, document_id, kind, ref_id) values (${o.orgId}, ${policy.id}, 'DEPARTMENT', ${unit?.id})`;
    await link(o, policy.id);

    const result = await gate(o);

    expect(result.code).toBe(1);
    expect(finding(result.out, "a link's audience is wider than its document's own")).toBe(true);
  }, 60_000);

  it("names an HR file registered as a KB attachment, and a chunk derived from it", async () => {
    const o = await org("attachment");
    const policy = await document(o);
    const registered = await attachment(o, policy.fileKey);
    await chunk(o, { source: "attachment", attachmentId: registered });

    const result = await gate(o);

    expect(result.code).toBe(1);
    expect(finding(result.out, "a KB attachment holds the storage key of an HR document or version")).toBe(true);
    expect(finding(result.out, "a chunk was derived from a KB attachment or source that holds an HR file")).toBe(true);
  }, 60_000);

  it("names an HR file registered as a KB source, and a checkpoint derived from it", async () => {
    const o = await org("source");
    const policy = await document(o);
    const [source] = await sql`insert into kb_sources (org_id, kind, title, file_key) values (${o.orgId}, 'file', 'x', ${policy.fileKey}) returning id`;
    await sql`insert into kb_ingestion_checkpoints (org_id, content_type, content_id, content_hash, chunk_index, content, embedding) values (${o.orgId}, 'source', ${source?.id}, 'h', 0, 'text', ${ZERO_VECTOR}::vector)`;

    const result = await gate(o);

    expect(result.code).toBe(1);
    expect(finding(result.out, "a KB source holds the storage key of an HR document or version")).toBe(true);
    expect(finding(result.out, "an ingestion checkpoint was derived from a KB attachment or source that holds an HR file")).toBe(true);
  }, 60_000);

  it("names a KB attachment and a KB source sitting under a sensitive folder, whatever they hold", async () => {
    const o = await org("sensitive");
    await document(o);
    await attachment(o, `${o.orgId}/payroll/${randomUUID()}.pdf`);
    await sql`insert into kb_sources (org_id, kind, title, file_key) values (${o.orgId}, 'file', 'x', ${`${o.orgId}/onboarding-docs/${randomUUID()}.pdf`})`;

    const result = await gate(o);

    expect(result.code).toBe(1);
    expect(finding(result.out, "a KB attachment sits under a sensitive folder root")).toBe(true);
    expect(finding(result.out, "a KB source sits under a sensitive folder root")).toBe(true);
  }, 60_000);

  it("names a chunk and a checkpoint of a kind the indexer never writes", async () => {
    const o = await org("unknown-kinds");
    await document(o);
    await chunk(o, { source: "hr_document" });
    await sql`insert into kb_ingestion_checkpoints (org_id, content_type, content_id, content_hash, chunk_index, content, embedding) values (${o.orgId}, 'hr_document', 1, 'h', 0, 'text', ${ZERO_VECTOR}::vector)`;

    const result = await gate(o);

    expect(result.code).toBe(1);
    expect(finding(result.out, 'a chunk has a source the indexer does not write ("hr_document")')).toBe(true);
    expect(finding(result.out, 'a checkpoint has a content type the indexer does not write ("hr_document")')).toBe(true);
  }, 60_000);

  it("scopes to the organisation it is asked about: another organisation's violation is not this one's", async () => {
    const clean = await org("scope-clean");
    await document(clean);
    const dirty = await org("scope-dirty");
    const policy = await document(dirty);
    await attachment(dirty, policy.fileKey);

    expect((await gate(clean)).code).toBe(0);
    expect((await gate(dirty)).code).toBe(1);
  }, 60_000);

  it("is INCONCLUSIVE, not clean, for an organisation with no documents", async () => {
    const o = await org("empty");

    const result = await gate(o);

    expect(result.code).toBe(2);
    expect(result.out).toContain("HR-KB INVARIANTS: INCONCLUSIVE");
    expect(result.err).toContain("no HR documents");
  }, 60_000);

  it("is INCONCLUSIVE with no connection string, and says which variable it needs", async () => {
    const result = await gate(null, {});

    expect(result.code).toBe(2);
    expect(result.err).toContain("HR_KB_DATABASE_URL");
  }, 60_000);

  it("is INCONCLUSIVE, not clean, when it cannot read the database at all", async () => {
    const result = await gate(null, { HR_KB_DATABASE_URL: "postgres://nobody@127.0.0.1:1/none" });

    expect(result.code).toBe(2);
    expect(result.err).toContain("INCONCLUSIVE");
  }, 60_000);
});
