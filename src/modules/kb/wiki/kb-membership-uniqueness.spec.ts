import { ConflictException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../../../db/drizzle.module";
import { KbMembersService } from "./kb-members.service";
import { KbPageTemplatesService } from "./kb-page-templates.service";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";
import type { KbAccessService } from "../core/kb-access.service";
import type { KbIndexingService } from "../retrieval/kb-indexing.service";

const BACKEND_ROOT = join(__dirname, "..", "..", "..", "..");

function readText(path: string): string {
  return readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
}

const ORG = "org-uniq-kb";
const SPACE_ID = 3;

function uniqueViolation(constraint: string) {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint,
  });
}

function membersHarness(insertOutcome: { throws?: unknown; returns?: unknown[] }) {
  const returning = jest.fn().mockImplementation(() =>
    insertOutcome.throws ? Promise.reject(insertOutcome.throws) : Promise.resolve(insertOutcome.returns ?? [{}]),
  );
  const values = jest.fn().mockReturnValue({ returning });
  const insert = jest.fn().mockReturnValue({ values });
  const spaceMemberLookup = jest.fn();
  const savedRow = insertOutcome.returns?.[0] ?? {};
  const db = {
    query: {
      kbSpaces: { findFirst: jest.fn().mockResolvedValue({ id: SPACE_ID }) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 11 }) },
      kbSpaceMembers: { findFirst: spaceMemberLookup },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        leftJoin: jest.fn().mockReturnValue({
          leftJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([savedRow]),
          }),
        }),
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{ slug: "EDITOR" }]),
        }),
      }),
    }),
    insert,
  } as unknown as Db;
  const service = new KbMembersService(
    db,
    { invalidateAccessibleSpaceIds: jest.fn() } as unknown as KbAccessService,
    { bumpSpaceAclRevision: jest.fn() } as unknown as KbIndexingService,
  );
  return { service, insert, values, spaceMemberLookup };
}

function templatesHarness(insertOutcome: { throws?: unknown; returns?: unknown[] }) {
  const returning = jest.fn().mockImplementation(() =>
    insertOutcome.throws ? Promise.reject(insertOutcome.throws) : Promise.resolve(insertOutcome.returns ?? [{}]),
  );
  const values = jest.fn().mockReturnValue({ returning });
  const insert = jest.fn().mockReturnValue({ values });
  const limit = jest.fn().mockResolvedValue([]);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const db = {
    query: { kbPages: { findFirst: jest.fn().mockResolvedValue({ id: 1, content: null, icon: null }) } },
    select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
    insert,
  } as unknown as Db;
  return { service: new KbPageTemplatesService(db), insert, limit };
}

describe("KbMembersService.add — the dedupe is backed by a constraint", () => {
  it("no longer reads for an existing grant before inserting", async () => {
    const h = membersHarness({ returns: [{ id: 1 }] });

    await h.service.add(ORG, SPACE_ID, { userId: "user-1", spaceRole: "viewer" });

    expect(h.spaceMemberLookup).not.toHaveBeenCalled();
    expect(h.insert).toHaveBeenCalledTimes(1);
  });

  it("BITE: a concurrent duplicate membership grant returns 409, not a 500", async () => {
    const h = membersHarness({ throws: uniqueViolation("uniq_kb_space_members_org_space_membership") });

    await expect(
      h.service.add(ORG, SPACE_ID, { userId: "user-1", spaceRole: "viewer" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("BITE: the two grains keep their own message — a role collision is not reported as a user collision", async () => {
    const roleClash = membersHarness({ throws: uniqueViolation("uniq_kb_space_members_org_space_role") });
    await expect(
      roleClash.service.add(ORG, SPACE_ID, { role: "EDITOR", spaceRole: "editor" }),
    ).rejects.toMatchObject({ message: "Role already granted" });

    const memberClash = membersHarness({ throws: uniqueViolation("uniq_kb_space_members_org_space_membership") });
    await expect(
      memberClash.service.add(ORG, SPACE_ID, { userId: "user-1", spaceRole: "viewer" }),
    ).rejects.toMatchObject({ message: "User already has access" });
  });

  it("does not swallow an unrelated database failure as a conflict", async () => {
    const h = membersHarness({ throws: Object.assign(new Error("deadlock detected"), { code: "40P01" }) });

    await expect(
      h.service.add(ORG, SPACE_ID, { userId: "user-1", spaceRole: "viewer" }),
    ).rejects.toMatchObject({ message: "deadlock detected" });
  });
});

describe("KbPageTemplatesService", () => {
  it("BITE: a duplicate template name returns 409 rather than a second indistinguishable row", async () => {
    const h = templatesHarness({ throws: uniqueViolation("uniq_kb_page_templates_org_name") });

    await expect(
      h.service.create({ orgId: ORG, userId: "user-1" } as never, { fromPageId: 1, name: "Meeting notes" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("BITE: list is bounded — it ordered by name with no limit at all", async () => {
    const h = templatesHarness({ returns: [] });

    await h.service.list(ORG, { limit: 50 });

    expect(h.limit).toHaveBeenCalledWith(51);
  });

  it("BITE: the bound is the caller's page size, never a larger locally invented cap that outruns PAGE_SIZE_CAP", async () => {
    const h = templatesHarness({ returns: [] });

    await h.service.list(ORG, { limit: PAGE_SIZE_CAP });

    expect(h.limit).toHaveBeenCalledWith(PAGE_SIZE_CAP + 1);
    expect(PAGE_SIZE_CAP).toBe(100);
  });
});

describe("the constraints exist in both declarations", () => {
  const spaces = readText(join(BACKEND_ROOT, "src/db/schema/kb/spaces.ts"));
  const collab = readText(join(BACKEND_ROOT, "src/db/schema/kb/page-collab.ts"));
  const tag = "1040_t29_kb_membership_and_template_uniques";
  const sql = readText(join(BACKEND_ROOT, `migrations/${tag}.sql`));

  it("declares both kb_space_members grains as partial uniques", () => {
    expect(spaces).toContain('uniqueIndex("uniq_kb_space_members_org_space_membership")');
    expect(spaces).toContain('uniqueIndex("uniq_kb_space_members_org_space_role")');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_space_members_org_space_membership"');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_space_members_org_space_role"');
  });

  it("BITE: each grain is partial on its own column, so a role grant and a membership grant coexist in one space", () => {
    expect(sql).toContain('ON "kb_space_members" ("org_id", "space_id", "membership_id")\n  WHERE "membership_id" IS NOT NULL');
    expect(sql).toContain('ON "kb_space_members" ("org_id", "space_id", "role")\n  WHERE "role" IS NOT NULL');
  });

  it("declares the template name as a per-org key, never a global one", () => {
    expect(collab).toContain('uniqueIndex("uniq_kb_page_templates_org_name").on(table.orgId, table.name)');
    expect(sql).toContain('ON "kb_page_templates" ("org_id", "name")');
  });

  it("BITE: the de-duplicating DELETEs only remove rows identical on every meaningful column, so a conflicting ACL pair fails the migration instead of being silently resolved", () => {
    expect(sql).toContain('a."space_role" = b."space_role"');
    expect(sql).toContain('a."role" IS NOT DISTINCT FROM b."role"');
    expect(sql).toContain('a."team" IS NOT DISTINCT FROM b."team"');
  });

  it("is journalled", () => {
    const journal = JSON.parse(
      readFileSync(join(BACKEND_ROOT, "migrations/meta/_journal.json"), "utf-8"),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.some((e) => e.tag === tag)).toBe(true);
  });
});
