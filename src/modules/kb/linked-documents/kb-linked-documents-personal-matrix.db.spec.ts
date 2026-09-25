import { randomUUID } from "node:crypto";
import { HttpException, NotFoundException } from "@nestjs/common";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import { HrmsKbSeed, member, type SeededOrg } from "../../../test/hrms-kb-seed.spec-fixtures";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { EntitlementsService } from "../../access/entitlements.service";
import { KbHrLinkFlagsService } from "../core/kb-hr-link-flags.service";
import { KbLinkedDocumentPublishService, type PublishActor } from "./kb-linked-document-publish.service";
import { KbLinkedDocumentQueryService, type LinkedDocumentCaller } from "./kb-linked-document-query.service";

const describeDb = dbSpecSuite();

const TYPES = ["CONTRACT", "CERTIFICATE", "ID_PROOF", "PAYSLIP", "POLICY", "OFFER_LETTER", "RESUME", "OTHER"] as const;
const CLASSIFICATIONS = ["PERSONAL", "CONFIDENTIAL", "RESTRICTED", "INTERNAL"] as const;
type Person = "hr" | "employee" | null;
const OWNERSHIPS: ReadonlyArray<{ owner: Person; uploader: Person }> = [
  { owner: null, uploader: null },
  { owner: null, uploader: "hr" },
  { owner: "hr", uploader: "hr" },
  { owner: "employee", uploader: "hr" },
  { owner: "employee", uploader: null },
];
const HIRING_STAMPS: ReadonlyArray<Record<string, unknown> | null> = [null, { candidateId: 7 }];

interface Cell {
  type: (typeof TYPES)[number];
  classification: (typeof CLASSIFICATIONS)[number];
  owner: Person;
  uploader: Person;
  hiring: Record<string, unknown> | null;
  isPublic: boolean;
  isActive: boolean;
}

function shouldBeShareable(cell: Cell): boolean {
  return (
    cell.isActive &&
    (cell.classification === "INTERNAL" || cell.classification === "RESTRICTED") &&
    (cell.type === "POLICY" || cell.type === "OTHER") &&
    (cell.owner === null || cell.owner === cell.uploader) &&
    cell.hiring === null
  );
}

const CONSONANTS = "bcdfghjklmnpqrstvwxz";
function word(n: number, width = 4): string {
  let out = "";
  let rest = n;
  for (let place = 0; place < width; place += 1) {
    out = CONSONANTS.charAt(rest % CONSONANTS.length) + out;
    rest = Math.floor(rest / CONSONANTS.length);
  }
  return out;
}
const randomWord = (width: number): string => Array.from({ length: width }, () => CONSONANTS.charAt(Math.floor(Math.random() * CONSONANTS.length))).join("");

async function inChunks<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += size) out.push(...(await Promise.all(items.slice(start, start + size).map(work))));
  return out;
}

describeDb("personal documents and the knowledge base — the whole grid, real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({ spec: "kb-linked-documents-personal-matrix.db.spec.ts", vars: ["DATABASE_URL", "APP_DATABASE_URL"] })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let seed: HrmsKbSeed;
  let a: SeededOrg;
  let b: SeededOrg;
  let publish: KbLinkedDocumentPublishService;
  let query: KbLinkedDocumentQueryService;
  const run = randomWord(10);

  const actorOf = (org: SeededOrg): PublishActor => ({ userId: member(org, "hr").id, orgId: org.orgId, membershipId: member(org, "hr").membershipId });
  const callerOf = (org: SeededOrg, name: string, canPublish: boolean): LinkedDocumentCaller => ({ orgId: org.orgId, userId: member(org, name).id, canPublish });
  const hr = () => callerOf(a, "hr", true);
  const employee = () => callerOf(a, "employee", false);
  const outsider = () => callerOf(a, "outsider", false);
  const otherTenantHr = () => callerOf(b, "hr", true);

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 8 });
    seed = new HrmsKbSeed(sql);
    a = await seed.org("matrix-a", ["hr", "employee", "outsider"]);
    b = await seed.org("matrix-b", ["hr"]);
    const db = drizzle(sql, { schema }) as unknown as Db;
    const audit = new AuditService(db);
    const entitlements = { isModuleEnabled: jest.fn().mockResolvedValue(true) } as unknown as EntitlementsService;
    publish = new KbLinkedDocumentPublishService(db, audit, new KbHrLinkFlagsService(db, entitlements, audit));
    query = new KbLinkedDocumentQueryService(db);
    await sql`insert into kb_settings (org_id, hrms_kb_link_enabled) values (${a.orgId}, true)`;
    const [person] = await sql`insert into hr_people (org_id, user_id) values (${a.orgId}, ${member(a, "employee").id}) returning id`;
    await sql`insert into hr_employments (org_id, person_id, employee_number, lifecycle_status) values (${a.orgId}, ${person?.id}, ${`E-${randomUUID().slice(0, 8)}`}, 'ACTIVE'::hr_employment_lifecycle_status)`;
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await seed.dispose();
    await sql.end({ timeout: 5 });
  }, 120_000);

  function personId(org: SeededOrg, who: Person): string | null {
    return who === null ? null : member(org, who).id;
  }

  async function insertDocument(org: SeededOrg, name: string, cell: Cell): Promise<number> {
    const [row] = await sql`
      insert into documents (org_id, user_id, uploaded_by, name, description, type, classification, is_public, is_active, metadata, file_url, file_name)
      values (${org.orgId}, ${personId(org, cell.owner)}, ${personId(org, cell.uploader)}, ${name}, ${`About ${name}`}, ${cell.type}, ${cell.classification},
              ${cell.isPublic}, ${cell.isActive}, ${cell.hiring === null ? null : JSON.stringify(cell.hiring)}::text::jsonb,
              ${`${org.orgId}/hr-documents/${randomUUID()}.pdf`}, 'file.pdf')
      returning id`;
    const id = Number(row?.id);
    await sql`insert into document_audiences (org_id, document_id, kind, ref_id) values (${org.orgId}, ${id}, 'ALL_EMPLOYEES', null)`;
    return id;
  }

  async function refusalOf(work: Promise<unknown>): Promise<HttpException | Error> {
    try {
      await work;
    } catch (error) {
      if (error instanceof Error) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  }

  async function everyEntry(caller: LinkedDocumentCaller, filter: { status?: "active" | "unpublished" | "source_removed" | "all"; q?: string }) {
    const seen: Awaited<ReturnType<KbLinkedDocumentQueryService["list"]>>["data"] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await query.list(caller, { limit: 100, ...filter, ...(cursor ? { cursor } : {}) });
      seen.push(...page.data);
      if (!page.pagination.hasMore || !page.pagination.nextCursor) return seen;
      cursor = page.pagination.nextCursor;
    }
  }

  describe("the grid: every combination against every door", () => {
    const cells: Cell[] = [];
    const idOf = new Map<Cell, number>();
    const tokenOf = new Map<Cell, string>();
    const linkOf = new Map<Cell, number>();
    let shareable: Cell[] = [];
    let notShareable: Cell[] = [];

    beforeAll(async () => {
      for (const type of TYPES)
        for (const classification of CLASSIFICATIONS)
          for (const { owner, uploader } of OWNERSHIPS)
            for (const hiring of HIRING_STAMPS)
              for (const isPublic of [false, true])
                for (const isActive of [true, false]) cells.push({ type, classification, owner, uploader, hiring, isPublic, isActive });
      expect(cells).toHaveLength(TYPES.length * CLASSIFICATIONS.length * OWNERSHIPS.length * HIRING_STAMPS.length * 2 * 2);

      await inChunks(cells.map((cell, index) => ({ cell, index })), 8, async ({ cell, index }) => {
        const token = `zq${word(index)}`;
        tokenOf.set(cell, token);
        idOf.set(cell, await insertDocument(a, `${run} handbook ${token}`, cell));
      });
      shareable = cells.filter(shouldBeShareable);
      notShareable = cells.filter((cell) => !shouldBeShareable(cell));
    }, 300_000);

    it("self-check: the grid holds both kinds, and the expected count of shareable cells is the one the rules give", () => {
      expect(shareable).toHaveLength(2 * 2 * 3 * 1 * 2 * 1);
      expect(notShareable.length).toBeGreaterThan(1000);
      expect(cells.filter((cell) => cell.classification === "PERSONAL" && shouldBeShareable(cell))).toEqual([]);
    });

    it("the database's own definition of shareable agrees with the requirement on every cell", async () => {
      const rows = await sql<Array<{ id: number; ok: boolean }>>`select d.id, app.hr_document_is_publishable(d) as ok from documents d where d.org_id = ${a.orgId}`;
      const dbSays = new Map(rows.map((row) => [row.id, row.ok]));
      const disagreements = cells.filter((cell) => dbSays.get(idOf.get(cell) ?? -1) !== shouldBeShareable(cell));
      expect(disagreements).toEqual([]);
    });

    it("publishing: every shareable cell is published, and every other cell is refused with the reason and leaves no row", async () => {
      const outcomes = await inChunks(cells, 8, async (cell) => {
        const documentId = idOf.get(cell) ?? -1;
        try {
          const state = await publish.publish(actorOf(a), documentId, {});
          return { cell, published: true as const, linkId: state.link?.id ?? -1, error: null };
        } catch (error) {
          return { cell, published: false as const, linkId: -1, error };
        }
      });

      for (const outcome of outcomes) if (outcome.published) linkOf.set(outcome.cell, outcome.linkId);
      const publishedWrongly = outcomes.filter((outcome) => outcome.published && !shouldBeShareable(outcome.cell));
      const refusedWrongly = outcomes.filter((outcome) => !outcome.published && shouldBeShareable(outcome.cell));
      const refusedOtherwise = outcomes.filter(
        (outcome) =>
          !outcome.published &&
          !shouldBeShareable(outcome.cell) &&
          !(outcome.error instanceof HttpException && outcome.error.getStatus() === 422 && JSON.stringify(outcome.error.getResponse()).includes("DOCUMENT_NOT_PUBLISHABLE")),
      );
      expect({ publishedWrongly: publishedWrongly.length, refusedWrongly: refusedWrongly.length, refusedOtherwise: refusedOtherwise.length }).toEqual({ publishedWrongly: 0, refusedWrongly: 0, refusedOtherwise: 0 });
      expect(linkOf.size).toBe(shareable.length);

      const [{ n }] = await sql<Array<{ n: number }>>`
        select count(*)::int as n from kb_linked_documents l
        join documents d on d.org_id = l.org_id and d.id = l.document_id
        where l.org_id = ${a.orgId} and d.name like ${`${run}%`} and not app.hr_document_is_publishable(d)`;
      expect(n).toBe(0);
    }, 300_000);

    it("the database refuses a link row for every cell that is not shareable, even when the service is skipped", async () => {
      const codes = await inChunks(notShareable, 8, async (cell) => {
        try {
          await sql`insert into kb_linked_documents (org_id, document_id) values (${a.orgId}, ${idOf.get(cell) ?? -1})`;
          return "inserted";
        } catch (error) {
          return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "other";
        }
      });
      const counts = codes.reduce<Record<string, number>>((acc, code) => ({ ...acc, [code]: (acc[code] ?? 0) + 1 }), {});
      expect(counts).toEqual({ "23514": notShareable.length });
    }, 300_000);

    it("the list shows exactly the shared documents to a publisher and to an employee in the audience, and nothing to anyone else", async () => {
      const shared = new Set(shareable.map((cell) => linkOf.get(cell)));
      const seenByHr = (await everyEntry(hr(), { q: run })).map((item) => item.id);
      const seenByEmployee = (await everyEntry(employee(), { q: run })).map((item) => item.id);
      expect(new Set(seenByHr)).toEqual(shared);
      expect(new Set(seenByEmployee)).toEqual(shared);
      expect(seenByHr).toHaveLength(shareable.length);
      expect(await everyEntry(outsider(), { q: run })).toEqual([]);
      expect(await everyEntry(otherTenantHr(), { q: run })).toEqual([]);
      expect(await everyEntry(otherTenantHr(), {})).toEqual([]);
      const all = (await everyEntry(hr(), { status: "all" })).map((item) => item.id);
      expect(new Set(all)).toEqual(shared);
    }, 120_000);

    it("searching by one document's own word finds it only if it is shared, for a publisher, an employee and an assistant", async () => {
      const wrong = (
        await inChunks(cells, 8, async (cell) => {
          const token = tokenOf.get(cell) ?? "";
          const link = linkOf.get(cell);
          const expected = link === undefined ? [] : [link];
          const [byHr, byEmployee, byAssistant] = await Promise.all([
            query.list(hr(), { limit: 100, q: token }).then((page) => page.data.map((item) => item.id)),
            query.list(employee(), { limit: 100, q: token }).then((page) => page.data.map((item) => item.id)),
            query.searchForCaller(employee(), token, 10).then((items) => items.map((item) => item.id)),
          ]);
          const ok = [byHr, byEmployee, byAssistant].every((seen) => JSON.stringify(seen) === JSON.stringify(expected));
          return ok ? null : { token, expected, byHr, byEmployee, byAssistant };
        })
      ).filter((row) => row !== null);
      expect(wrong).toEqual([]);
    }, 300_000);

    it("an assistant retrieves only shared documents, and never more than it was asked for", async () => {
      const found = await query.searchForCaller(employee(), run, 3);
      expect(found.length).toBeLessThanOrEqual(3);
      const shared = new Set(shareable.map((cell) => linkOf.get(cell)));
      expect(found.every((item) => shared.has(item.id))).toBe(true);
      expect(await query.searchForCaller(outsider(), run, 3)).toEqual([]);
      expect(await query.searchForCaller(otherTenantHr(), run, 3)).toEqual([]);
    });

    it("another tenant can neither read, open nor cite a shared entry by its id", async () => {
      const ids = [...linkOf.values()];
      expect(await query.visibleIds(otherTenantHr(), ids.slice(0, 100))).toEqual(new Set());
      for (const id of ids.slice(0, 5)) {
        await expect(query.get(otherTenantHr(), id)).rejects.toBeInstanceOf(NotFoundException);
        await expect(query.resolveFile(otherTenantHr(), id)).rejects.toBeInstanceOf(NotFoundException);
      }
    });

    it("none of it reached anything the knowledge base indexes: no chunk, attachment, source or checkpoint holds a file of these documents", async () => {
      const [row] = await sql<Array<{ attachments: number; sources: number; chunks: number; checkpoints: number }>>`
        select
          (select count(*)::int from kb_page_attachments t join documents d on d.org_id = t.org_id and d.file_url = t.file_key where t.org_id = ${a.orgId}) as attachments,
          (select count(*)::int from kb_sources t join documents d on d.org_id = t.org_id and (d.file_url = t.file_key or d.file_url = t.file_url) where t.org_id = ${a.orgId}) as sources,
          (select count(*)::int from kb_article_chunks where org_id = ${a.orgId}) as chunks,
          (select count(*)::int from kb_ingestion_checkpoints where org_id = ${a.orgId}) as checkpoints`;
      expect(row).toEqual({ attachments: 0, sources: 0, chunks: 0, checkpoints: 0 });
    });
  });

  describe("a document that WAS shared, and then stops being shareable", () => {
    interface Degrade {
      label: string;
      set: string;
      args?: string[];
    }
    const DEGRADES: readonly Degrade[] = [
      { label: "is reclassified Personal", set: "classification = 'PERSONAL'" },
      { label: "is reclassified Confidential", set: "classification = 'CONFIDENTIAL'" },
      { label: "is changed to a contract", set: "type = 'CONTRACT'" },
      { label: "is changed to a payslip", set: "type = 'PAYSLIP'" },
      { label: "is handed to an employee", set: "user_id = $3" },
      { label: "is stamped by a hiring flow", set: `metadata = '{"offerId": 3}'::jsonb` },
      { label: "is removed", set: "is_active = false" },
    ];
    type Runner = Pick<typeof sql, "unsafe">;
    const degrade = (runner: Runner, change: Degrade, documentId: number) =>
      runner.unsafe(`update documents set ${change.set} where org_id = $1 and id = $2`, [a.orgId, documentId, ...(change.set.includes("$3") ? [member(a, "employee").id] : [])]);
    const shareableCell: Cell = { type: "POLICY", classification: "INTERNAL", owner: null, uploader: "hr", hiring: null, isPublic: true, isActive: true };

    async function shared(label: string): Promise<{ documentId: number; linkId: number; token: string }> {
      const token = `zq${randomWord(8)}`;
      const documentId = await insertDocument(a, `${run} degrade ${label.replace(/[^a-z]/gi, "")} ${token}`, shareableCell);
      const state = await publish.publish(actorOf(a), documentId, {});
      return { documentId, linkId: state.link?.id ?? -1, token };
    }

    async function seenBy(caller: LinkedDocumentCaller, linkId: number, token: string) {
      const [live, ai, cited] = await Promise.all([
        query.list(caller, { limit: 100, q: token }).then((page) => page.data.some((item) => item.id === linkId)),
        query.searchForCaller(caller, token, 10).then((items) => items.some((item) => item.id === linkId)),
        query.visibleIds(caller, [linkId]).then((ids) => ids.has(linkId)),
      ]);
      const detail = await query.get(caller, linkId).then(
        () => true,
        () => false,
      );
      const file = await query.resolveFile(caller, linkId).then(
        () => true,
        () => false,
      );
      return { live, ai, cited, detail, file };
    }

    it.each(DEGRADES)("a shared document that $label is gone from every reader's list, search, detail, file and citation at once", async (change) => {
      const { documentId, linkId, token } = await shared(change.label);
      for (const caller of [hr(), employee()]) expect(await seenBy(caller, linkId, token)).toEqual({ live: true, ai: true, cited: true, detail: true, file: true });

      await degrade(sql, change, documentId);

      expect(await seenBy(employee(), linkId, token)).toEqual({ live: false, ai: false, cited: false, detail: false, file: false });
      expect(await seenBy(outsider(), linkId, token)).toEqual({ live: false, ai: false, cited: false, detail: false, file: false });
      expect(await seenBy(otherTenantHr(), linkId, token)).toEqual({ live: false, ai: false, cited: false, detail: false, file: false });
      const publisher = await seenBy(hr(), linkId, token);
      expect(publisher).toMatchObject({ live: false, ai: false, cited: false, file: false });

      const [link] = await sql<Array<{ status: string; reason: string | null }>>`select status, unpublish_reason as reason from kb_linked_documents where org_id = ${a.orgId} and id = ${linkId}`;
      expect(link?.status).toBe(change.label === "is removed" ? "source_removed" : "unpublished");
      expect(link?.reason).toBe("source_no_longer_publishable");
      const [audit] = await sql<Array<{ n: number }>>`select count(*)::int as n from audit_logs where org_id = ${a.orgId} and action = 'kb.hr_link.auto_unpublished' and target_id = ${String(documentId)}`;
      expect(audit?.n).toBe(1);
    }, 60_000);

    it.each(DEGRADES)("with the unlink trigger out of the way, an entry whose document $label is still invisible everywhere, the publisher's own view included", async (change) => {
      const { documentId, linkId, token } = await shared(`stale ${change.label}`);
      await sql.begin(async (tx) => {
        await tx`alter table documents disable trigger trg_documents_unlink_when_unpublishable`;
        try {
          await degrade(tx, change, documentId);
        } finally {
          await tx`alter table documents enable trigger trg_documents_unlink_when_unpublishable`;
        }
      });

      const [link] = await sql<Array<{ status: string }>>`select status from kb_linked_documents where org_id = ${a.orgId} and id = ${linkId}`;
      expect(link?.status).toBe("active");
      for (const caller of [hr(), employee(), outsider(), otherTenantHr()])
        expect(await seenBy(caller, linkId, token)).toEqual({ live: false, ai: false, cited: false, detail: false, file: false });
      expect((await everyEntry(hr(), { status: "all" })).some((item) => item.id === linkId)).toBe(false);
    }, 60_000);

    it.each(DEGRADES)("the publisher's record of an entry whose document $label says nothing about the document", async (change) => {
      const { documentId, linkId } = await shared(`record ${change.label}`);
      await degrade(sql, change, documentId);

      const listed = (await everyEntry(hr(), { status: "all" })).find((item) => item.id === linkId);
      const detail = await query.get(hr(), linkId);

      for (const item of [listed, detail]) {
        expect(item).toMatchObject({ id: linkId, name: null, description: null, category: null, documentType: null, effectiveDate: null, fileName: null, fileSize: null, mimeType: null, hasFile: false, tags: [] });
      }
    }, 60_000);

    it("searching the words of a document that is no longer shareable finds nothing, even under the publisher's own status filter", async () => {
      const { documentId, token } = await shared("search after");
      await sql`update documents set classification = 'PERSONAL' where org_id = ${a.orgId} and id = ${documentId}`;

      for (const status of ["all", "unpublished", "source_removed", "active"] as const)
        expect((await query.list(hr(), { limit: 100, status, q: token })).data).toEqual([]);
    }, 60_000);

    it("making the document shareable again does not put the entry back: a person has to publish it again", async () => {
      const { documentId, linkId, token } = await shared("restored");
      await sql`update documents set classification = 'PERSONAL' where org_id = ${a.orgId} and id = ${documentId}`;
      await sql`update documents set classification = 'INTERNAL' where org_id = ${a.orgId} and id = ${documentId}`;

      expect(await seenBy(employee(), linkId, token)).toEqual({ live: false, ai: false, cited: false, detail: false, file: false });

      const state = await publish.publish(actorOf(a), documentId, {});
      expect(state.link?.id).toBe(linkId);
      expect(await seenBy(employee(), linkId, token)).toEqual({ live: true, ai: true, cited: true, detail: true, file: true });
    }, 60_000);

    it("a withdrawn row written straight to the database for a personal document is still unreadable and says nothing about it", async () => {
      const personal = await insertDocument(a, `${run} tombstone zq${randomWord(8)}`, { ...shareableCell, classification: "PERSONAL", type: "PAYSLIP" });
      const [row] = await sql`
        insert into kb_linked_documents (org_id, document_id, status, unpublished_at, unpublish_reason)
        values (${a.orgId}, ${personal}, 'unpublished', now(), 'written directly') returning id`;
      const linkId = Number(row?.id);

      expect(await seenBy(employee(), linkId, run)).toEqual({ live: false, ai: false, cited: false, detail: false, file: false });
      const detail = await query.get(hr(), linkId);
      expect(detail).toMatchObject({ name: null, description: null, category: null, documentType: null, fileName: null, hasFile: false });
    }, 60_000);

    it("refuses to publish, and audits the refusal, for a document that is no longer shareable", async () => {
      const { documentId } = await shared("refused after");
      await sql`update documents set classification = 'CONFIDENTIAL' where org_id = ${a.orgId} and id = ${documentId}`;

      const error = await refusalOf(publish.publish(actorOf(a), documentId, {}));

      expect(error).toBeInstanceOf(HttpException);
      expect(error instanceof HttpException && error.getStatus()).toBe(422);
      const [audit] = await sql<Array<{ n: number }>>`select count(*)::int as n from audit_logs where org_id = ${a.orgId} and action = 'kb.hr_link.publish_refused' and target_id = ${String(documentId)}`;
      expect(audit?.n).toBe(1);
    }, 60_000);
  });
});
