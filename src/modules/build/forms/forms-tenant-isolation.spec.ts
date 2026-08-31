import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { FormsService } from "./forms.service";

describe("FormsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const audit = { log: jest.fn() } as never;

  function makeDb(projectRow: unknown | null, formRow: unknown | null = null) {
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(projectRow) },
        projectForms: { findFirst: jest.fn().mockResolvedValue(formRow), findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;
  }

  it("throws NotFoundException for getForm when project is from a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new FormsService(db, audit);
    await expect(svc.getForm(ATTACKER_ORG, 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException for getForm when form not found for different org (cross-tenant isolation)", async () => {
    const project = { id: 1, orgId: OWNER_ORG };
    const db = makeDb(project, null);
    const svc = new FormsService(db, audit);
    await expect(svc.getForm(ATTACKER_ORG, 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns form for the owning org (same-tenant control)", async () => {
    const project = { id: 1, orgId: OWNER_ORG };
    const form = { id: 1, orgId: OWNER_ORG, projectId: 1, title: "Form" };
    const db = makeDb(project, form);
    const svc = new FormsService(db, audit);
    const result = await svc.getForm(OWNER_ORG, 1, 1);
    expect(result).toMatchObject({ id: 1 });
  });
});
