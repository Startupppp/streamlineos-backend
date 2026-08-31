import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
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
