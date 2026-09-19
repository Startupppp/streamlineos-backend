import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import type { FeedbucketMediaStorage } from "./feedbucket-submissions.service";
import { FeedbucketSubmissionsService } from "./feedbucket-submissions.service";
import { FeedbucketWidgetsService } from "./feedbucket-widgets.service";

const mockStorage: jest.Mocked<FeedbucketMediaStorage> = {
  deleteFileIfPresent: jest.fn(),
};

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
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

function makeSubmissionDb(findFirstResult: unknown): { db: Db; findFirst: jest.Mock } {
  const findFirst = jest.fn().mockResolvedValue(findFirstResult);
  const limit = jest.fn().mockResolvedValue([]);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  const db = {
    query: { feedbucketSubmissions: { findFirst } },
    select: jest.fn().mockReturnValue({ from }),
  } as unknown as Db;
  return { db, findFirst };
}

describe("FeedbucketSubmissionsService — cross-tenant isolation", () => {
  describe("findOne", () => {
    it("throws NotFoundException when submission belongs to a different org (cross-tenant DENY)", async () => {
      const { db, findFirst } = makeSubmissionDb(undefined);
      const svc = new FeedbucketSubmissionsService(db, mockStorage);

      await expect(svc.findOne(ATTACKER_ORG, 77)).rejects.toThrow(NotFoundException);

      expect(findFirst).toHaveBeenCalledTimes(1);
      const callArg = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(callArg?.where)).toContain(ATTACKER_ORG);
    });

    it("returns the submission for the owning org (same-tenant CONTROL)", async () => {
      const row = { id: 77, orgId: OWNER_ORG, message: "Bug found", deletedAt: null };
      const { db } = makeSubmissionDb(row);
      const svc = new FeedbucketSubmissionsService(db, mockStorage);

      const result = await svc.findOne(OWNER_ORG, 77);

      expect(result).toMatchObject({ id: 77 });
    });
  });
});

describe("FeedbucketWidgetsService — cross-tenant isolation", () => {
  describe("findOne", () => {
    it("throws NotFoundException when widget belongs to a different org (cross-tenant DENY)", async () => {
      const findFirst = jest.fn().mockResolvedValue(undefined);
      const db = {
        query: { feedbucketWidgets: { findFirst } },
      } as unknown as Db;
      const svc = new FeedbucketWidgetsService(db);

      await expect(svc.findOne(ATTACKER_ORG, 55)).rejects.toThrow(NotFoundException);

      expect(findFirst).toHaveBeenCalledTimes(1);
      const callArg = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(callArg?.where)).toContain(ATTACKER_ORG);
    });

    it("returns the widget for the owning org (same-tenant CONTROL)", async () => {
      const row = { id: 55, orgId: OWNER_ORG, name: "My Widget", deletedAt: null };
      const findFirst = jest.fn().mockResolvedValue(row);
      const db = {
        query: { feedbucketWidgets: { findFirst } },
      } as unknown as Db;
      const svc = new FeedbucketWidgetsService(db);

      const result = await svc.findOne(OWNER_ORG, 55);

      expect(result).toMatchObject({ id: 55 });
    });
  });
});
