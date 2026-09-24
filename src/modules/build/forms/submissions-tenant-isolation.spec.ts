import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AccessService } from "../../access/access.service";
import { SubmissionsService } from "./submissions.service";

function makeActor(orgId: string): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, false),
  };
}

function makeSelectChain(rows: unknown[]) {
  const chain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

async function makeService(db: object, access: object) {
  const module = await Test.createTestingModule({
    providers: [
      SubmissionsService,
      { provide: DRIZZLE, useValue: db },
      { provide: AccessService, useValue: access },
      { provide: AuditService, useValue: { log: jest.fn() } },
    ],
  }).compile();
  return { module, service: module.get(SubmissionsService) };
}

describe("SubmissionsService tenant and project isolation", () => {
  const ownerOrg = "org-owner";
  const attackerOrg = "org-attacker";
  const manageAccess = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])),
  };

  function makeDb(formRow: unknown | null, submissionRows: unknown[] = [], submissionRow: unknown | null = null) {
    const listChain = makeSelectChain(submissionRows);
    const transaction = jest.fn();
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(formRow ? { managerMembershipId: 1 } : undefined) },
        projectForms: { findFirst: jest.fn().mockResolvedValue(formRow) },
        formSubmissions: { findFirst: jest.fn().mockResolvedValue(submissionRow) },
      },
      select: jest.fn().mockReturnValue(listChain),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction,
    };
    transaction.mockImplementation((work: (tx: object) => Promise<unknown>) => work(db));
    return db;
  }

  it("returns 404 when an authenticated route targets another tenant's form", async () => {
    const db = makeDb(null);
    const { module, service } = await makeService(db, manageAccess);

    await expect(service.listSubmissions(makeActor(attackerOrg), 1, 99, {})).rejects.toThrow(NotFoundException);
    await module.close();
  });

  it("returns submissions for a caller with project access", async () => {
    const form = { id: 1, orgId: ownerOrg, projectId: 1, formNumber: 1 };
    const db = makeDb(form, [{ id: 1 }]);
    const { module, service } = await makeService(db, manageAccess);

    await expect(service.listSubmissions(makeActor(ownerOrg), 1, 1, {})).resolves.toEqual([{ id: 1 }]);
    await module.close();
  });

  it("returns 404 when an update targets another tenant's submission", async () => {
    const form = { id: 99, orgId: ownerOrg, projectId: 1, formNumber: 1, isActive: true, deletedAt: null };
    const db = makeDb(form, [], null);
    const { module, service } = await makeService(db, manageAccess);

    await expect(
      service.updateSubmission(makeActor(ownerOrg), 1, 99, 999, { status: "processed" }),
    ).rejects.toThrow(NotFoundException);
    await module.close();
  });

  it("blocks reads, submissions, and status changes before loading a form for a project non-member", async () => {
    const accessRows = makeSelectChain([]);
    const projectFormsFind = jest.fn();
    const update = jest.fn();
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 99 }) },
        projectForms: { findFirst: projectFormsFind },
        formSubmissions: { findFirst: jest.fn() },
      },
      select: jest.fn().mockReturnValue(accessRows),
      update,
    };
    const { module, service } = await makeService(db, {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
    });
    const actor = makeActor(ownerOrg);

    await expect(service.listSubmissions(actor, 1, 1, {})).rejects.toThrow(ForbiddenException);
    await expect(service.createSubmission(actor, 1, 1, { values: {} })).rejects.toThrow(ForbiddenException);
    await expect(
      service.updateSubmission(actor, 1, 1, 5, { status: "processed" }),
    ).rejects.toThrow(ForbiddenException);
    expect(projectFormsFind).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    await module.close();
  });
});

describe("SubmissionsService public form isolation", () => {
  it("returns 404 for an unknown public token", async () => {
    const transaction = jest.fn();
    const db = {
      query: { projectForms: { findFirst: jest.fn().mockResolvedValue(undefined) } },
      transaction,
      execute: jest.fn().mockResolvedValue(undefined),
    };
    transaction.mockImplementation((work: (tx: object) => Promise<unknown>) => work(db));
    const { module, service } = await makeService(db, {});

    await expect(service.submitPublicForm("unknown-token", { values: {} })).rejects.toThrow(NotFoundException);
    await module.close();
  });

  it("uses the tenant and project resolved from the public form", async () => {
    const form = {
      id: 5,
      orgId: "org-owner",
      projectId: 2,
      formNumber: 3,
      name: "Feedback",
      isActive: true,
      isPublic: true,
      publicToken: "tok-owner",
      deletedAt: null,
      actions: [],
    };
    const createdSubmission = {
      id: 20,
      orgId: "org-owner",
      formId: 5,
      projectId: 2,
      values: {},
      status: "submitted",
      submittedByName: null,
      submittedById: null,
      convertedTicketId: null,
      createdAt: new Date(),
    };
    const values = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([createdSubmission]),
    });
    const insert = jest.fn().mockReturnValue({ values });
    const transaction = jest.fn();
    const db = {
      query: { projectForms: { findFirst: jest.fn().mockResolvedValue(form) } },
      insert,
      execute: jest.fn().mockResolvedValue(undefined),
      transaction,
    };
    transaction.mockImplementation((work: (tx: object) => Promise<unknown>) => work(db));
    const { module, service } = await makeService(db, {});

    await expect(service.submitPublicForm("tok-owner", { values: {} })).resolves.toMatchObject({
      id: 20,
      status: "submitted",
    });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-owner",
      projectId: 2,
      formId: 5,
      submittedById: null,
    }));
    await module.close();
  });
});
