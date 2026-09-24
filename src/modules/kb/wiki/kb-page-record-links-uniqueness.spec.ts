import { ConflictException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPageRecordLinksService } from "./kb-page-record-links.service";

function makeAuthMock() {
  return {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest.fn().mockResolvedValue({ orgId: "org-uniq", pageId: 7, action: "edit", via: "admin" }),
  };
}

const BACKEND_ROOT = join(__dirname, "..", "..", "..", "..");

const ORG = "org-uniq";
const PAGE_ID = 7;

const DTO = { targetType: "crm_deal", targetId: "deal-1", label: "Renewal" } as const;

function makeUser() {
  return { orgId: ORG, userId: "user-1", isOrgOwner: false } as never;
}

function makeDb(insertOutcome: { throws?: unknown; returns?: unknown[] }) {
  const pageLookup = jest.fn().mockResolvedValue({ id: PAGE_ID });
  const recordLookup = jest.fn();
  const returning = jest.fn().mockImplementation(() => {
    if (insertOutcome.throws) return Promise.reject(insertOutcome.throws);
    return Promise.resolve(insertOutcome.returns ?? []);
  });
  const values = jest.fn().mockReturnValue({ returning });
  const insert = jest.fn().mockReturnValue({ values });

  const makeChain = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {
      where: jest.fn().mockResolvedValue([]),
      limit: jest.fn().mockResolvedValue([]),
    };
    chain.innerJoin = jest.fn().mockReturnValue(chain);
    chain.leftJoin = jest.fn().mockReturnValue(chain);
    return chain;
  };

  const db = {
    query: {
      kbPages: { findFirst: pageLookup },
      kbPageLinks: { findFirst: recordLookup },
    },
    select: jest.fn().mockReturnValue({ from: jest.fn().mockImplementation(makeChain) }),
    insert,
  } as unknown as Db;

  return { db, insert, values, pageLookup, recordLookup };
}

describe("KbPageRecordLinksService.add — the dedupe is backed by a constraint", () => {
  it("no longer reads for an existing link before inserting", async () => {
    const h = makeDb({ returns: [{ id: 1, ...DTO }] });
    const service = new KbPageRecordLinksService(h.db, makeAuthMock() as never);

    await service.add(makeUser(), PAGE_ID, { ...DTO });

    expect(h.recordLookup).not.toHaveBeenCalled();
    expect(h.insert).toHaveBeenCalledTimes(1);
  });

  it("BITE: a concurrent duplicate that only the database can see still returns 409, not a 500", async () => {
    const violation = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      constraint: "uniq_kb_page_links_org_source_record",
    });
    const service = new KbPageRecordLinksService(makeDb({ throws: violation }).db, makeAuthMock() as never);

    await expect(service.add(makeUser(), PAGE_ID, { ...DTO })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("BITE: a unique violation nested in a Drizzle wrapper is still recognised", async () => {
    const inner = Object.assign(new Error("duplicate key"), { code: "23505" });
    const wrapped = Object.assign(new Error("Failed query"), { cause: inner });
    const service = new KbPageRecordLinksService(makeDb({ throws: wrapped }).db, makeAuthMock() as never);

    await expect(service.add(makeUser(), PAGE_ID, { ...DTO })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("does not swallow an unrelated database failure as a conflict", async () => {
    const other = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const service = new KbPageRecordLinksService(makeDb({ throws: other }).db, makeAuthMock() as never);

    await expect(service.add(makeUser(), PAGE_ID, { ...DTO })).rejects.toMatchObject({
      message: "deadlock detected",
    });
  });

  it("add requests 'edit' access not 'view' because creating a record link is a page mutation", async () => {
    const h = makeDb({ returns: [{ id: 1, ...DTO }] });
    const authMock = makeAuthMock();
    const service = new KbPageRecordLinksService(h.db, authMock as never);

    await service.add(makeUser(), PAGE_ID, { ...DTO });

    expect(authMock.assertPageAccess).toHaveBeenCalledTimes(1);
    const [, , action] = authMock.assertPageAccess.mock.calls[0] as [unknown, unknown, string];
    expect(action).not.toBe("view");
    expect(action).toBe("edit");
  });
});

describe("kb_page_links record grain — the constraint exists in both declarations", () => {
  it("is declared in Drizzle as a partial unique on (org_id, source_page_id, target_type, target_id)", () => {
    const schema = readFileSync(join(BACKEND_ROOT, "src/db/schema/kb/pages.ts"), "utf-8");
    const block = schema.slice(schema.indexOf('uniqueIndex("uniq_kb_page_links_org_source_record")'));

    expect(block).toContain("table.orgId");
    expect(block).toContain("table.sourcePageId");
    expect(block).toContain("table.targetType");
    expect(block).toContain("table.targetId");
    expect(block.slice(0, 400)).toContain("IS NOT NULL");
  });

  it("BITE: the pre-existing (source_page_id, target_page_id) unique cannot constrain a record link, because target_page_id is NULL there", () => {
    const schema = readFileSync(join(BACKEND_ROOT, "src/db/schema/kb/pages.ts"), "utf-8");

    expect(schema).toContain('uniqueIndex("uniq_kb_page_links_source_target").on(table.sourcePageId, table.targetPageId)');
    expect(schema).toContain('targetPageId: integer("target_page_id"),');
    expect(schema).not.toContain('targetPageId: integer("target_page_id").notNull()');
  });

  it("is created by a journalled migration", () => {
    const journal = JSON.parse(
      readFileSync(join(BACKEND_ROOT, "migrations/meta/_journal.json"), "utf-8"),
    ) as { entries: Array<{ tag: string }> };
    const tag = "1021_t29_kb_page_links_record_unique";

    expect(journal.entries.some((e) => e.tag === tag)).toBe(true);

    const sql = readFileSync(join(BACKEND_ROOT, `migrations/${tag}.sql`), "utf-8");
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_page_links_org_source_record"');
    expect(sql).toContain('WHERE "target_id" IS NOT NULL');
    expect(sql).toContain("SET lock_timeout");
  });
});
