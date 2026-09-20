import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { SubmissionsService } from "./submissions.service";

describe("SubmissionsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const audit = { log: jest.fn() } as never;

  function makeDb(formRow: unknown | null, submissionRows: unknown[] = [], submissionRow: unknown | null = null) {
    const mockLimit = jest.fn().mockResolvedValue(submissionRows);
    const mockOrderBy = jest.fn().mockReturnValue({ limit: mockLimit });
    const mockWhere = jest.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = jest.fn().mockReturnValue({ where: mockWhere });
    const query = {
      projectForms: { findFirst: jest.fn().mockResolvedValue(formRow) },
      formSubmissions: { findFirst: jest.fn().mockResolvedValue(submissionRow) },
    };
    const db = {
      query,
      select: jest.fn().mockReturnValue({ from: mockFrom }),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    };
    return db as unknown as Db;
  }

  it("throws NotFoundException for listSubmissions when form not in org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new SubmissionsService(db, audit);
    await expect(svc.listSubmissions(ATTACKER_ORG, 1, 99, {})).rejects.toThrow(NotFoundException);
  });

  it("returns submissions for the owning org (same-tenant control)", async () => {
    const form = { id: 1, orgId: OWNER_ORG, projectId: 1, formNumber: 1 };
    const db = makeDb(form, [{ id: 1 }]);
    const svc = new SubmissionsService(db, audit);
    const result = await svc.listSubmissions(OWNER_ORG, 1, 1, {});
    expect(Array.isArray(result)).toBe(true);
  });

  it("throws NotFoundException for updateSubmission when form not in org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new SubmissionsService(db, audit);
    await expect(
      svc.updateSubmission(ATTACKER_ORG, "user-1", 1, 99, 5, { status: "processed" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException for updateSubmission when submission is from a different org", async () => {
    const form = { id: 99, orgId: OWNER_ORG, projectId: 1, formNumber: 1, isActive: true, deletedAt: null };
    const db = makeDb(form, [], null);
    const svc = new SubmissionsService(db, audit);
    await expect(
      svc.updateSubmission(OWNER_ORG, "user-1", 1, 99, 999, { status: "processed" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException for submitPublicForm when publicToken is unknown", async () => {
    const db = makeDb(null);
    const svc = new SubmissionsService(db, audit);
    await expect(svc.submitPublicForm("unknown-token", { values: {} })).rejects.toThrow(NotFoundException);
  });

  it("public form submit uses orgId from form row, not caller-supplied (no cross-tenant via publicToken)", async () => {
    const form = {
      id: 5, orgId: OWNER_ORG, projectId: 2, formNumber: 3,
      name: "Feedback", isActive: true, isPublic: true, publicToken: "tok-owner",
      deletedAt: null, actions: [],
    };

    const createdSubmission = {
      id: 20, orgId: OWNER_ORG, formId: 5, projectId: 2,
      values: {}, status: "submitted", submittedByName: null,
      submittedById: null, convertedTicketId: null, createdAt: new Date(),
    };

    const mockInsert = jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([createdSubmission]),
      }),
    });

    const dbWithPublicForm = {
      query: {
        projectForms: { findFirst: jest.fn().mockResolvedValue(form) },
        formSubmissions: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn(),
      insert: mockInsert,
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          execute: jest.fn().mockResolvedValue(undefined),
          select: jest.fn(),
          insert: mockInsert,
          query: {
            projectForms: { findFirst: jest.fn().mockResolvedValue(form) },
            formSubmissions: { findFirst: jest.fn().mockResolvedValue(null) },
          },
        };
        return fn(tx);
      }),
    } as unknown as Db;

    const svc = new SubmissionsService(dbWithPublicForm, audit);
    const result = await svc.submitPublicForm("tok-owner", { values: {} });

    expect(result.status).toBe("submitted");
    const insertedValues = (mockInsert.mock.results[0]?.value as { values: jest.Mock }).values.mock.calls[0][0] as Record<string, unknown>;
    expect(insertedValues["orgId"]).toBe(OWNER_ORG);
  });
});
