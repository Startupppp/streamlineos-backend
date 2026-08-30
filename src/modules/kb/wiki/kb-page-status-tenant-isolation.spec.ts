import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { KbPageStatusService } from "./kb-page-status.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value as object)) return [];
  seen.add(value as object);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeUser(orgId: string): CurrentUserContext {
  return {
    orgId,
    userId: "user-uuid-1",
    isOrgOwner: true,
    principal: undefined,
  } as unknown as CurrentUserContext;
}

describe("KbPageStatusService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner-uuid";
  const ATTACKER_ORG = "org-attacker-uuid";
  const PAGE_ID = 42;

  describe("lock — assertPageAccessible + update predicate", () => {
    it("throws NotFoundException when page belongs to a different org (cross-tenant deny)", async () => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const db = {
        query: { kbPages: { findFirst } },
      } as unknown as Db;

      const svc = new KbPageStatusService(db, null as never);
      await expect(svc.lock(makeUser(ATTACKER_ORG), PAGE_ID, true)).rejects.toThrow(NotFoundException);
    });

    it("includes orgId in the update where clause for the owning org (control)", async () => {
      const PAGE_ROW = {
        id: PAGE_ID,
        orgId: OWNER_ORG,
        title: "Test Page",
        status: "draft",
        isLocked: false,
        lastEditedById: null,
        lastEditedByMembershipId: null,
      };
      const findFirst = jest.fn().mockResolvedValue({ id: PAGE_ID });
      const updateWhere = jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([PAGE_ROW]),
      });
      const db = {
        query: { kbPages: { findFirst } },
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) }),
      } as unknown as Db;

      const svc = new KbPageStatusService(db, null as never);
      await svc.lock(makeUser(OWNER_ORG), PAGE_ID, true);

      expect(updateWhere).toHaveBeenCalledTimes(1);
      const whereArg = updateWhere.mock.calls[0]?.[0];
      const vals = sqlValues(whereArg);
      expect(vals).toContain(OWNER_ORG);
      expect(vals).toContain(PAGE_ID);
    });
  });
});
