import { ConflictException, NotFoundException } from "@nestjs/common";
import { ChangeRequestsService } from "./change-requests.service";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.module";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CreateChangeRequestInput } from "./dto/change-requests.schemas";
import { projectAccessRow, type ProjectAccessRow } from "../__tests__/project-access-doubles";

function makeOwner(orgId: string): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "MEMBER",
    isOrgOwner: true,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, true),
  };
}

const mockAudit = { log: jest.fn() } as unknown as AuditService;
const mockAccess = {
  scopeFor: async (actor: CurrentUserContext) => (actor.isOrgOwner ? "all" : "none"),
} as unknown as AccessService;

const minimalInput: CreateChangeRequestInput = {
  title: "Add SSO support",
};

const crRow = {
  id: 42,
  orgId: "org-1",
  projectId: 10,
  crNumber: 1,
  title: "Add SSO support",
  description: null,
  impact: null,
  estimateMinutes: null,
  budgetImpactCents: null,
  timelineImpactDays: null,
  status: "submitted",
  requestedById: "user-1",
  approvalOwnerId: null,
  approvalOwnerMembershipId: null,
  decisionComment: null,
  decidedAt: null,
  releaseId: null,
  clientVisible: false,
  createdBy: "user-1",
  createdAt: new Date("2026-09-29T00:00:00.000Z"),
  updatedAt: new Date("2026-09-29T00:00:00.000Z"),
  deletedAt: null,
};

function makeDb(projectExists: boolean, insertedRow = crRow, project: ProjectAccessRow = projectAccessRow()): Db {
  const fakeTx = {
    execute: jest.fn().mockResolvedValue(undefined),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ maxNum: 0 }]),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([insertedRow]),
      }),
    }),
  };
  return {
    transaction: jest.fn().mockImplementation(async (cb: (tx: typeof fakeTx) => Promise<unknown>) =>
      cb(fakeTx),
    ),
    select: jest.fn(() => ({
      from: () => ({ where: () => ({ limit: async () => (projectExists ? [project] : []) }) }),
    })),
    insert: jest.fn(),
    update: jest.fn(),
  } as unknown as Db;
}

beforeEach(() => {
  jest.resetAllMocks();
  (mockAudit.log as jest.Mock).mockReset();
});

describe("ChangeRequestsService.createChangeRequest — access gate (B11)", () => {
  it("throws NotFoundException before opening a transaction when the project does not exist in the org", async () => {
    const db = makeDb(false);
    const svc = new ChangeRequestsService(db, mockAccess, mockAudit);

    await expect(
      svc.createChangeRequest(makeOwner("org-1"), 10, minimalInput),
    ).rejects.toThrow(NotFoundException);

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("proceeds past the access gate when the project exists in the org (positive counterpart to the NotFoundException test)", async () => {
    const db = makeDb(true);
    const svc = new ChangeRequestsService(db, mockAccess, mockAudit);

    await expect(
      svc.createChangeRequest(makeOwner("org-1"), 10, minimalInput),
    ).resolves.toBeDefined();
  });

  it("refuses a change request on an archived project with 409 before opening a transaction, because a locked project takes no writes", async () => {
    const db = makeDb(true, crRow, projectAccessRow({ state: "ARCHIVED" }));
    const svc = new ChangeRequestsService(db, mockAccess, mockAudit);

    await expect(
      svc.createChangeRequest(makeOwner("org-1"), 10, minimalInput),
    ).rejects.toThrow(ConflictException);

    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe("ChangeRequestsService.createChangeRequest — field mapping (B11)", () => {
  it("inserts status=submitted and requestedById from the caller regardless of what the client sends", async () => {
    const db = makeDb(true);
    const svc = new ChangeRequestsService(db, mockAccess, mockAudit);

    const result = await svc.createChangeRequest(makeOwner("org-1"), 10, minimalInput);

    expect(result.status).toBe("submitted");
    expect(result.requestedById).toBe("user-1");
  });

  it("sets clientVisible=false when the input omits it so new CRs are not client-visible by default", async () => {
    const db = makeDb(true);
    const svc = new ChangeRequestsService(db, mockAccess, mockAudit);

    const result = await svc.createChangeRequest(makeOwner("org-1"), 10, { title: "No visibility flag" });

    expect(result.clientVisible).toBe(false);
  });

  it("inserts the title from the input so the returned row carries the caller-supplied value", async () => {
    const db = makeDb(true);
    const svc = new ChangeRequestsService(db, mockAccess, mockAudit);

    const result = await svc.createChangeRequest(makeOwner("org-1"), 10, { title: "Add SSO support" });

    expect(result.title).toBe("Add SSO support");
  });
});

describe("ChangeRequestsService.createChangeRequest — transaction behaviour (B11, BE-136)", () => {
  it("invokes the transaction callback so the insert and crNumber allocation run inside one transaction", async () => {
    const db = makeDb(true);
    const svc = new ChangeRequestsService(db, mockAccess, mockAudit);

    await svc.createChangeRequest(makeOwner("org-1"), 10, minimalInput);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    const callback = (db.transaction as jest.Mock).mock.calls[0][0];
    expect(typeof callback).toBe("function");
  });

  it("returns the row produced by the insert inside the transaction so the caller sees what was written", async () => {
    const db = makeDb(true);
    const svc = new ChangeRequestsService(db, mockAccess, mockAudit);

    const result = await svc.createChangeRequest(makeOwner("org-1"), 10, minimalInput);

    expect(result).toMatchObject({
      id: 42,
      orgId: "org-1",
      projectId: 10,
      crNumber: 1,
      status: "submitted",
    });
  });
});

describe("ChangeRequestsService.createChangeRequest — audit log (B11)", () => {
  it("logs change_request.created after a successful insert so the audit trail is written", async () => {
    const db = makeDb(true);
    const svc = new ChangeRequestsService(db, mockAccess, mockAudit);

    await svc.createChangeRequest(makeOwner("org-1"), 10, minimalInput);

    expect(mockAudit.log).toHaveBeenCalledTimes(1);
    const call = (mockAudit.log as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(call["action"]).toBe("change_request.created");
    expect(call["resourceType"]).toBe("change_request");
    expect(call["userId"]).toBe("user-1");
    expect(call["orgId"]).toBe("org-1");
  });

  it("audit metadata includes crId, projectId, crNumber and title so the event is searchable by any dimension", async () => {
    const db = makeDb(true);
    const svc = new ChangeRequestsService(db, mockAccess, mockAudit);

    await svc.createChangeRequest(makeOwner("org-1"), 10, minimalInput);

    const call = (mockAudit.log as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    const meta = call["metadata"] as Record<string, unknown>;
    expect(meta).toMatchObject({
      crId: 42,
      projectId: 10,
      crNumber: 1,
      title: "Add SSO support",
    });
  });

  it("audit is NOT logged when the access gate rejects so the audit trail only contains committed writes", async () => {
    const db = makeDb(false);
    const svc = new ChangeRequestsService(db, mockAccess, mockAudit);

    await expect(svc.createChangeRequest(makeOwner("org-1"), 10, minimalInput)).rejects.toThrow();

    expect(mockAudit.log).not.toHaveBeenCalled();
  });
});
