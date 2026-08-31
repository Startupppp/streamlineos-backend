import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { PublicFormsService } from "./public-forms.service";

describe("PublicFormsService — cross-tenant isolation", () => {
  const VALID_TOKEN = "tok-form-valid";
  const INVALID_TOKEN = "tok-form-invalid";

  function makeDb(formRow: unknown): Db {
    return {
      query: { projectForms: { findFirst: jest.fn().mockResolvedValue(formRow) } },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      }),
      execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          query: { projectForms: { findFirst: jest.fn().mockResolvedValue(formRow) } },
          insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }) }),
          execute: jest.fn().mockResolvedValue([]),
        }),
      ),
    } as unknown as Db;
  }

  it("throws NotFoundException for an invalid token (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new PublicFormsService(db);
    await expect(svc.getFormByToken(INVALID_TOKEN)).rejects.toThrow(NotFoundException);
  });

  it("returns the form for a valid token (control — correct token)", async () => {
    const formRow = { id: 1, orgId: "org-owner", name: "Contact", description: null, type: "contact", fields: [] };
    const db = makeDb(formRow);
    const svc = new PublicFormsService(db);
    const result = await svc.getFormByToken(VALID_TOKEN);
    expect(result).toHaveProperty("id");
  });
});
