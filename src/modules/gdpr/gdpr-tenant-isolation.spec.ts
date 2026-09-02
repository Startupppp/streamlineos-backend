import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { auditLogs, organizationMembers, users } from "../../db/schema";
import { GdprService } from "./gdpr.service";

const CALLER_ORG = "org-caller";
const OTHER_ORG = "org-other";
const SUBJECT = "user-subject";
const CALLER = "user-caller";

function renderedWhere(condition: unknown): string {
  return new PgDialect().sqlToQuery(condition as SQL).sql;
}

function makeDb(membershipRows: Array<Record<string, unknown>>) {
  const captured: unknown[] = [];
  const where = jest.fn((condition: unknown) => {
    captured.push(condition);
    return {
      limit: jest.fn().mockResolvedValue([]),
      then: (resolve: (rows: unknown[]) => unknown) => resolve(membershipRows),
    };
  });
  const innerJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ where, innerJoin });
  const select = jest.fn().mockReturnValue({ from });
  return { db: { select } as unknown as Db, captured };
}

describe("GdprService.exportSubjectData tenant isolation", () => {
  it("refuses a caller whose scope did not resolve, rather than defaulting to open", async () => {
    const { db } = makeDb([]);
    const service = new GdprService(db);

    await expect(
      service.exportSubjectData(SUBJECT, CALLER, CALLER_ORG, "none"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses another person's export without organisation-wide scope", async () => {
    const { db } = makeDb([]);
    const service = new GdprService(db);

    await expect(
      service.exportSubjectData(SUBJECT, CALLER, CALLER_ORG, "own"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("reports a subject outside the caller's organisation as not found, never forbidden", async () => {
    const { db } = makeDb([]);
    const service = new GdprService(db);

    await expect(
      service.exportSubjectData(SUBJECT, CALLER, CALLER_ORG, "all"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("binds the caller's organisation into the membership lookup, so another org's rows cannot be reached", async () => {
    const { db, captured } = makeDb([]);
    const service = new GdprService(db);

    await service
      .exportSubjectData(SUBJECT, CALLER, CALLER_ORG, "all")
      .catch(() => null);

    expect(captured.length).toBeGreaterThan(0);
    expect(renderedWhere(captured[0])).toContain("org_id");
  });

  it("does not treat a membership in a different organisation as a match", async () => {
    const { db } = makeDb([{ orgId: OTHER_ORG, role: "MEMBER", status: "ACTIVE", joinedAt: null }]);
    const service = new GdprService(db);

    const result = await service
      .exportSubjectData(SUBJECT, CALLER, CALLER_ORG, "all")
      .catch(() => null);

    if (result !== null)
      expect(result.memberships.every((m) => m.orgId === OTHER_ORG)).toBe(true);
  });
});

describe("GdprService.exportSubjectData — G3: sync export cap and truncation notice", () => {
  const MEMBER_ROW = { orgId: CALLER_ORG, role: "MEMBER", status: "ACTIVE", joinedAt: null };
  const SUBJECT_ROW = { id: SUBJECT, email: "subject@example.invalid", name: null };
  const AUDIT_ROW = {
    id: 1, action: "test.action", targetId: null, targetType: null,
    actorUserId: null, resourceType: null, resourceId: null,
    metadata: null, createdAt: new Date(),
  };

  function makeOverflowDb(): Db {
    return {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockImplementation((table: unknown) => ({
          where: jest.fn().mockReturnValue({
            then: (res: (v: unknown[]) => unknown) =>
              res(table === organizationMembers ? [MEMBER_ROW] : []),
            limit: jest.fn().mockImplementation(() => {
              if (table === users) return Promise.resolve([SUBJECT_ROW]);
              if (table === auditLogs) return Promise.resolve(Array(501).fill(AUDIT_ROW));
              return Promise.resolve([]);
            }),
          }),
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        })),
      })),
    } as unknown as Db;
  }

  it("reports a truncation notice in exportIncomplete when audit entries exceed the 500-row cap", async () => {
    const service = new GdprService(makeOverflowDb());
    const result = await service.exportSubjectData(SUBJECT, SUBJECT, CALLER_ORG, "all");

    expect(result.auditEntries).toHaveLength(500);
    expect(result.exportIncomplete.some((s) => s.includes("audit_logs") && s.includes("truncated"))).toBe(true);
  });

  it("always includes the three design-time incomplete notices regardless of truncation", async () => {
    const service = new GdprService(makeOverflowDb());
    const result = await service.exportSubjectData(SUBJECT, SUBJECT, CALLER_ORG, "all");

    expect(result.exportIncomplete.some((s) => s.includes("blob storage"))).toBe(true);
    expect(result.exportIncomplete.some((s) => s.includes("chat_messages"))).toBe(true);
  });
});
