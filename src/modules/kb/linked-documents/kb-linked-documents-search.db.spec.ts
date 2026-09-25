/**
 * HRMS-KB PR 5 — finding a linked HR document by its words, and handing one to an assistant, against a real Postgres.
 *
 * Search must never widen what a reader can see. Every case below is a person who could type the exact title of a
 * document and still must not be told it exists: the wrong audience, a personal document, a withdrawn entry,
 * another tenant. The search runs over the document's own metadata, joined at query time; there is no copy of it
 * to go stale, and nothing here reads a file.
 *
 * Run with:
 *   DATABASE_URL=postgres://user@localhost:5432/scratch_… ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     npx jest --config ./jest-db.json --runInBand --testPathPattern=kb-linked-documents-search
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import { HrmsKbSeed, member, type SeededOrg } from "../../../test/hrms-kb-seed.spec-fixtures";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { KbLinkedDocumentQueryService, type LinkedDocumentCaller } from "./kb-linked-document-query.service";

const describeDb = dbSpecSuite();

describeDb("linked documents: search and assistant retrieval — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({ spec: "kb-linked-documents-search.db.spec.ts", vars: ["DATABASE_URL", "APP_DATABASE_URL"] })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let seed: HrmsKbSeed;
  let a: SeededOrg;
  let b: SeededOrg;
  let service: KbLinkedDocumentQueryService;
  let deptOne: string;
  let deptTwo: string;

  const reader = (org: SeededOrg, name: string, canPublish = false): LinkedDocumentCaller => ({
    orgId: org.orgId,
    userId: member(org, name).id,
    canPublish,
  });

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    seed = new HrmsKbSeed(sql);
    a = await seed.org("a", ["hr", "onedept", "twodept"]);
    b = await seed.org("b", ["hr", "outsider"]);
    service = new KbLinkedDocumentQueryService(drizzle(sql, { schema }) as unknown as Db);

    deptOne = await unit(a);
    deptTwo = await unit(a);
    await employ(a, "onedept", deptOne);
    await employ(a, "twodept", deptTwo);
    await employ(b, "outsider", null);
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await seed.dispose();
    await sql.end({ timeout: 5 });
  }, 120_000);

  async function unit(org: SeededOrg): Promise<string> {
    const id = randomUUID();
    await sql`insert into org_units (id, org_id, kind, name, code) values (${id}, ${org.orgId}, 'DEPARTMENT', ${`DEPARTMENT-${id.slice(0, 6)}`}, ${id.slice(0, 8)})`;
    return id;
  }

  async function employ(org: SeededOrg, name: string, department: string | null): Promise<void> {
    const [person] = await sql`insert into hr_people (org_id, user_id) values (${org.orgId}, ${member(org, name).id}) returning id`;
    await sql`
      insert into hr_employments (org_id, person_id, employee_number, lifecycle_status, department_id)
      values (${org.orgId}, ${person?.id}, ${`E-${randomUUID().slice(0, 8)}`}, 'ACTIVE'::hr_employment_lifecycle_status, ${department})`;
  }

  type Audience = readonly [kind: string, ref: string | null];

  async function entry(
    org: SeededOrg,
    opts: { name: string; description?: string; category?: string; tags?: string[]; audience: readonly Audience[]; classification?: string },
  ): Promise<{ documentId: number; linkId: number }> {
    const hr = member(org, "hr").id;
    const [doc] = await sql`
      insert into documents (org_id, uploaded_by, name, description, type, classification, file_url, file_name, category, tags)
      values (${org.orgId}, ${hr}, ${opts.name}, ${opts.description ?? null}, 'POLICY', ${opts.classification ?? "INTERNAL"},
              ${`${org.orgId}/hr-documents/${randomUUID()}.pdf`}, 'file.pdf', ${opts.category ?? null}, ${sql.array(opts.tags ?? [], 25)})
      returning id`;
    const documentId = Number(doc?.id);
    for (const [kind, ref] of opts.audience)
      await sql`insert into document_audiences (org_id, document_id, kind, ref_id) values (${org.orgId}, ${documentId}, ${kind}, ${ref})`;
    const [link] = await sql`insert into kb_linked_documents (org_id, document_id) values (${org.orgId}, ${documentId}) returning id`;
    const linkId = Number(link?.id);
    for (const [kind, ref] of opts.audience)
      await sql`insert into kb_linked_document_audiences (org_id, linked_document_id, kind, ref_id) values (${org.orgId}, ${linkId}, ${kind}, ${ref})`;
    return { documentId, linkId };
  }

  const everyone: readonly Audience[] = [["ALL_EMPLOYEES", null]];
  const found = async (caller: LinkedDocumentCaller, q: string): Promise<number[]> =>
    (await service.list(caller, { limit: 100, q })).data.map((item) => item.id);
  const retrieved = async (caller: LinkedDocumentCaller, question: string): Promise<number[]> =>
    (await service.searchForCaller(caller, question, 10)).map((item) => item.id);

  describe("list with q", () => {
    it("finds an entry by its name, description, category or a tag, and by nothing else", async () => {
      const word = randomUUID().slice(0, 8).replace(/\d/g, "x");
      const byName = await entry(a, { name: `Handbook ${word}alpha`, audience: everyone });
      const byDescription = await entry(a, { name: "Untitled one", description: `Covers ${word}beta rules`, audience: everyone });
      const byCategory = await entry(a, { name: "Untitled two", category: `${word}gamma`, audience: everyone });
      const byTag = await entry(a, { name: "Untitled three", tags: [`${word}delta`], audience: everyone });
      const caller = reader(a, "onedept");

      expect(await found(caller, `${word}alpha`)).toEqual([byName.linkId]);
      expect(await found(caller, `${word}beta`)).toEqual([byDescription.linkId]);
      expect(await found(caller, `${word}gamma`)).toEqual([byCategory.linkId]);
      expect(await found(caller, `${word}delta`)).toEqual([byTag.linkId]);
      expect(await found(caller, `${word}nothing`)).toEqual([]);
    });

    it("needs every word to match, as a person narrowing a search expects", async () => {
      const word = randomUUID().slice(0, 8).replace(/\d/g, "y");
      const both = await entry(a, { name: `${word}remote work`, description: `${word}equipment`, audience: everyone });
      await entry(a, { name: `${word}remote only`, audience: everyone });

      expect(await found(reader(a, "onedept"), `${word}remote ${word}equipment`)).toEqual([both.linkId]);
    });

    it("finds nothing, not everything, for text that holds no word", async () => {
      await entry(a, { name: "Anything", audience: everyone });

      const page = await service.list(reader(a, "onedept"), { limit: 100, q: "?! -- ''" });

      expect(page.data).toEqual([]);
      expect(page.pagination.hasMore).toBe(false);
    });

    it("does not let the words be read as search operators or as SQL", async () => {
      const word = randomUUID().slice(0, 8).replace(/\d/g, "z");
      const shown = await entry(a, { name: `Policy ${word}`, audience: everyone });
      const caller = reader(a, "onedept");

      expect(await found(caller, word)).toEqual([shown.linkId]);
      await expect(service.list(caller, { limit: 100, q: `${word} & ! ( | ) : * <->` })).resolves.toBeDefined();
      expect(await found(caller, `${word}'; drop table documents; --`)).toEqual([]);
      const [still] = await sql`select count(*)::int as n from documents`;
      expect(Number(still?.n)).toBeGreaterThan(0);
    });
  });

  describe("search never widens what a reader can see", () => {
    it("does not find a department's entry for someone in another department, even by its exact title", async () => {
      const word = randomUUID().slice(0, 8).replace(/\d/g, "q");
      const mine = await entry(a, { name: `${word} salary bands`, audience: [["DEPARTMENT", deptOne]] });

      expect(await found(reader(a, "onedept"), `${word} salary bands`)).toEqual([mine.linkId]);
      expect(await found(reader(a, "twodept"), `${word} salary bands`)).toEqual([]);
      expect(await retrieved(reader(a, "twodept"), `what are the ${word} salary bands`)).toEqual([]);
      expect(await found(reader(a, "hr", true), `${word} salary bands`)).toEqual([mine.linkId]);
    });

    it("does not find a document that became personal, though nothing took its entry down", async () => {
      const word = randomUUID().slice(0, 8).replace(/\d/g, "p");
      const shown = await entry(a, { name: `${word} onboarding`, audience: everyone });
      await sql.begin(async (tx) => {
        await tx`alter table documents disable trigger trg_documents_unlink_when_unpublishable`;
        try {
          await tx`update documents set classification = 'PERSONAL' where id = ${shown.documentId}`;
        } finally {
          await tx`alter table documents enable trigger trg_documents_unlink_when_unpublishable`;
        }
      });

      expect(await found(reader(a, "onedept"), `${word} onboarding`)).toEqual([]);
      expect(await found(reader(a, "hr", true), `${word} onboarding`)).toEqual([]);
      expect(await retrieved(reader(a, "hr", true), `${word} onboarding`)).toEqual([]);
    });

    it("does not find a withdrawn entry, and lets a publisher find it under its own status", async () => {
      const word = randomUUID().slice(0, 8).replace(/\d/g, "w");
      const gone = await entry(a, { name: `${word} travel`, audience: everyone });
      await sql`update kb_linked_documents set status = 'unpublished', unpublished_at = now(), unpublish_reason = 'manual' where id = ${gone.linkId}`;

      expect(await found(reader(a, "onedept"), `${word} travel`)).toEqual([]);
      expect(await retrieved(reader(a, "onedept"), `${word} travel`)).toEqual([]);
      const asPublisher = await service.list(reader(a, "hr", true), { limit: 100, q: `${word} travel`, status: "unpublished" });
      expect(asPublisher.data.map((item) => item.id)).toEqual([gone.linkId]);
    });

    it("tenant isolation: a reader finds only their own tenant's entry, even when both tenants use the same title", async () => {
      const word = randomUUID().slice(0, 8).replace(/\d/g, "t");
      const mine = await entry(a, { name: `${word} code of conduct`, audience: everyone });
      const theirs = await entry(b, { name: `${word} code of conduct`, audience: everyone });
      const onlyMine = await entry(a, { name: `${word} secret annex`, audience: everyone });
      await employ(b, "hr", null);

      expect(await found(reader(a, "onedept"), `${word} code of conduct`)).toEqual([mine.linkId]);
      expect(await found(reader(b, "outsider"), `${word} code of conduct`)).toEqual([theirs.linkId]);
      expect(await found(reader(b, "hr", true), `${word} code of conduct`)).toEqual([theirs.linkId]);
      expect(await retrieved(reader(b, "hr", true), `${word} code of conduct`)).toEqual([theirs.linkId]);

      expect(await found(reader(b, "outsider"), `${word} secret annex`)).toEqual([]);
      expect(await found(reader(b, "hr", true), `${word} secret annex`)).toEqual([]);
      expect(await retrieved(reader(b, "hr", true), `${word} secret annex`)).not.toContain(onlyMine.linkId);
      expect([...(await service.visibleIds(reader(b, "hr", true), [onlyMine.linkId, mine.linkId]))]).toEqual([]);
    });
  });

  describe("retrieval for an assistant", () => {
    it("finds the policy a question in a sentence is about, though only some of its words appear", async () => {
      const word = randomUUID().slice(0, 8).replace(/\d/g, "l");
      const other = randomUUID().slice(0, 8).replace(/\d/g, "m");
      const leave = await entry(a, { name: `${word} leave policy`, description: "Annual leave, sick leave and carry over", audience: everyone });
      const parking = await entry(a, { name: `Parking ${other}`, audience: everyone });

      const hits = await retrieved(reader(a, "onedept"), `How many days of ${word} leave do I get each year?`);

      expect(hits[0]).toBe(leave.linkId);
      expect(hits).not.toContain(parking.linkId);
    });

    it("ranks the better match first and never returns more than it was asked for", async () => {
      const word = randomUUID().slice(0, 8).replace(/\d/g, "r");
      const weak = await entry(a, { name: "Misc", description: word, audience: everyone });
      const strong = await entry(a, { name: `${word} ${word} bonus`, description: `${word} bonus plan`, category: `${word} bonus`, audience: everyone });

      const ordered = (await service.searchForCaller(reader(a, "onedept"), `${word} bonus`, 10)).map((item) => item.id);

      expect(ordered).toEqual(expect.arrayContaining([strong.linkId, weak.linkId]));
      expect(ordered.indexOf(strong.linkId)).toBeLessThan(ordered.indexOf(weak.linkId));
      expect(await service.searchForCaller(reader(a, "onedept"), `${word} bonus`, 1)).toHaveLength(1);
    });

    it("hands over only a small projection: no storage key, no file name, no owner", async () => {
      const word = randomUUID().slice(0, 8).replace(/\d/g, "k");
      await entry(a, { name: `${word} projection`, audience: everyone });

      const [hit] = await service.searchForCaller(reader(a, "onedept"), `${word} projection`, 5);

      expect(hit).toBeDefined();
      expect(JSON.stringify(hit)).not.toMatch(/hr-documents|uploaded|metadata|fileUrl/i);
    });

    it("says which entries a caller may still open, and drops one withdrawn since", async () => {
      const word = randomUUID().slice(0, 8).replace(/\d/g, "v");
      const open = await entry(a, { name: `${word} open`, audience: everyone });
      const closed = await entry(a, { name: `${word} closed`, audience: [["DEPARTMENT", deptTwo]] });
      const caller = reader(a, "onedept");

      expect([...(await service.visibleIds(caller, [open.linkId, closed.linkId]))]).toEqual([open.linkId]);

      await sql`update kb_linked_documents set status = 'unpublished', unpublished_at = now(), unpublish_reason = 'manual' where id = ${open.linkId}`;
      expect((await service.visibleIds(caller, [open.linkId, closed.linkId])).size).toBe(0);
      expect((await service.visibleIds(caller, [])).size).toBe(0);
    });
  });

  /**
   * V-159. The paging case seeded a homogeneous set, so "a page is still full after the audience filter runs"
   * was never actually tested: with every row visible, full pages prove nothing. Visibility is applied in SQL,
   * inside the same statement that takes the limit — if it were applied in TypeScript after the rows came back,
   * a page of 5 would arrive as 2 or 3 and a reader would page through the document list seeing gaps.
   */
  describe("paging a set where visible and invisible entries alternate", () => {
    const PAGE = 5;
    const PAIRS = 12;

    it("returns full pages of exactly the limit until the last, and every visible entry exactly once", async () => {
      const word = randomUUID().slice(0, 8).replace(/\d/g, "p");
      const caller = reader(a, "onedept");
      const visible: number[] = [];
      const hidden: number[] = [];

      // Interleaved as they are written, so the ids alternate and no page can be filled without the SQL
      // predicate skipping over rows the caller may not see.
      for (let index = 0; index < PAIRS; index += 1) {
        visible.push((await entry(a, { name: `${word} page ${index} mine`, audience: everyone })).linkId);
        hidden.push((await entry(a, { name: `${word} page ${index} theirs`, audience: [["DEPARTMENT", deptTwo]] })).linkId);
      }

      const seen: number[] = [];
      const pageSizes: number[] = [];
      let cursor: string | undefined;
      // Bounded so a paging bug cannot spin here forever.
      for (let guard = 0; guard <= PAIRS + 2; guard += 1) {
        const page = await service.list(caller, { limit: PAGE, q: word, ...(cursor === undefined ? {} : { cursor }) });
        pageSizes.push(page.data.length);
        seen.push(...page.data.map((item) => item.id));
        if (!page.pagination.hasMore) break;
        cursor = page.pagination.nextCursor ?? undefined;
        expect(cursor).toBeDefined();
      }

      // The fixture is real: there genuinely are invisible rows interleaved with the visible ones.
      expect(visible).toHaveLength(PAIRS);
      expect(hidden).toHaveLength(PAIRS);
      expect(seen).toEqual(expect.arrayContaining(visible));
      expect(seen).toHaveLength(PAIRS);
      expect(new Set(seen).size).toBe(PAIRS);
      for (const id of hidden) expect(seen).not.toContain(id);

      // Every page but the last is exactly the limit. A filter applied after the fetch would short them.
      expect(pageSizes.slice(0, -1).every((size) => size === PAGE)).toBe(true);
      expect(pageSizes.at(-1)).toBe(PAIRS % PAGE === 0 ? PAGE : PAIRS % PAGE);
      expect(pageSizes.slice(0, -1)).not.toHaveLength(0);
    });
  });
});
