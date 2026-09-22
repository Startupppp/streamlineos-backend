import { ConflictException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { BudgetsService } from "../budgets.service";

const ORG = "org-budgets";

function pgError(code: string) {
  return Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("db"), { code }) });
}

function harness(insertError?: Error, updateError?: Error) {
  const db = {
    select: () => ({
      from: () => ({
        where: () => Object.assign(Promise.resolve([{ id: 1, orgId: ORG, projectId: 3, status: "ACTIVE" }]), {
          limit: async () => [{ id: 9 }],
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => (insertError ? Promise.reject(insertError) : Promise.resolve([{ id: 1 }])),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => (updateError ? Promise.reject(updateError) : Promise.resolve(undefined)),
      }),
    }),
  } as unknown as Db;
  const audit = { recordWithDb: jest.fn() };
  return { service: new BudgetsService(db, audit as never), audit };
}

describe("budget writes answer the constraints they trip", () => {
  it("a second active budget for the project is a 409", async () => {
    const { service, audit } = harness(pgError("23505"));

    await expect(service.create(ORG, "u", { projectId: 3, budgetHours: 10 })).rejects.toBeInstanceOf(ConflictException);
    expect(audit.recordWithDb).not.toHaveBeenCalled();
  });

  it("a project the organisation does not have is a 404, not a 500 and not a 403", async () => {
    const { service } = harness(pgError("23503"));

    await expect(service.create(ORG, "u", { projectId: 999, budgetHours: 10 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("an update that reactivates a second budget is a 409 too", async () => {
    const { service } = harness(undefined, pgError("23505"));

    await expect(service.update(ORG, "u", 1, { status: "ACTIVE" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("any other failure is still raised as itself", async () => {
    const { service } = harness(new Error("connection reset"));

    await expect(service.create(ORG, "u", { projectId: 3, budgetHours: 10 })).rejects.toThrow("connection reset");
  });
});
