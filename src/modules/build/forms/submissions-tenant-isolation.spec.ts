import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { SubmissionsService } from "./submissions.service";

describe("SubmissionsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const audit = { log: jest.fn() } as never;

  function makeDb(formRow: unknown | null, submissionRows: unknown[] = []) {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(submissionRows) }) });
    const from = jest.fn().mockReturnValue({ where });
    return {
      query: {
        projectForms: { findFirst: jest.fn().mockResolvedValue(formRow) },
        formSubmissions: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
  }

  it("throws NotFoundException for listSubmissions when form not in org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new SubmissionsService(db, audit);
    await expect(svc.listSubmissions(ATTACKER_ORG, 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns submissions for the owning org (same-tenant control)", async () => {
    const form = { id: 1, orgId: OWNER_ORG, projectId: 1, formNumber: 1 };
    const db = makeDb(form, [{ id: 1 }]);
    const svc = new SubmissionsService(db, audit);
    const result = await svc.listSubmissions(OWNER_ORG, 1, 1);
    expect(Array.isArray(result)).toBe(true);
  });
});
