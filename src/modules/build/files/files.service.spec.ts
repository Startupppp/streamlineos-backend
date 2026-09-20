import { ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { FilesService } from "./files.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { AccessService } from "../../access/access.service";
import type { StorageService } from "../../storage/storage.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

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

type MockDb = {
  query: { projects: { findFirst: jest.Mock } };
  select: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
};

function makeMockDb(): MockDb {
  return {
    query: { projects: { findFirst: jest.fn() } },
    select: jest.fn().mockReturnValue(makeSelectChain([{ role: "MEMBER" }])),
    insert: jest.fn(),
    update: jest.fn(),
  };
}

function makeAccess(perms: Set<string> = new Set()): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(perms),
  } as unknown as AccessService;
}

function makeStorage(configured = true): StorageService {
  return {
    isConfigured: jest.fn().mockReturnValue(configured),
    uploadFile: jest.fn().mockResolvedValue({ key: "build/1/files/uuid-test.pdf", size: 4, mimeType: "application/pdf", sha256: "abc" }),
    getFileUrl: jest.fn().mockResolvedValue("https://cdn.example.com/signed"),
  } as unknown as StorageService;
}

function makeUser(orgId: string, membershipId = 7, userId = "user-1"): CurrentUserContext {
  return {
    userId,
    orgId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(membershipId, false),
  };
}

const mockAudit = { log: jest.fn() } as unknown as AuditService;

beforeEach(() => jest.resetAllMocks());

describe("FilesService.listFiles — cross-tenant isolation (BOLA)", () => {
  it("rejects a non-member with ForbiddenException before returning rows", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    db.select
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]));
    const svc = new FilesService(db as unknown as Db, makeAccess(), mockAudit, makeStorage());

    await expect(svc.listFiles(makeUser("org-1"), 1, {})).rejects.toThrow(ForbiddenException);
  });

  it("allows a project member and returns a cursor page", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    db.select
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(makeSelectChain([]));
    const svc = new FilesService(db as unknown as Db, makeAccess(), mockAudit, makeStorage());

    const result = await svc.listFiles(makeUser("org-1"), 1, {});
    expect(result).toMatchObject({ data: [], pagination: { hasMore: false, nextCursor: null } });
  });

  it("returns 404 when the project does not belong to the caller's org", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue(undefined);
    db.select.mockReturnValueOnce(makeSelectChain([]));
    const svc = new FilesService(db as unknown as Db, makeAccess(), mockAudit, makeStorage());

    await expect(svc.listFiles(makeUser("org-attacker"), 1, {})).rejects.toThrow(NotFoundException);
  });
});

describe("FilesService.uploadFile — storage and tenant isolation", () => {
  it("throws ServiceUnavailableException when storage is not configured", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    db.select.mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]));
    const svc = new FilesService(db as unknown as Db, makeAccess(), mockAudit, makeStorage(false));

    const input = { fileName: "test.pdf", mimeType: "application/pdf" as const, contentBase64: "JVBER" };
    await expect(svc.uploadFile(makeUser("org-1", 7), 1, input)).rejects.toThrow(ServiceUnavailableException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("stores the caller's membershipId as uploadedByMembershipId", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    db.select.mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]));

    const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const contentBase64 = PDF_MAGIC.toString("base64");

    let capturedValues: Record<string, unknown> | undefined;
    db.insert.mockImplementation(() => ({
      values: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
        capturedValues = vals;
        return {
          returning: jest.fn().mockResolvedValue([{
            id: 1,
            orgId: vals["orgId"],
            projectId: vals["projectId"],
            uploadedByMembershipId: vals["uploadedByMembershipId"],
            fileName: vals["fileName"],
            mimeType: vals["mimeType"],
            sizeBytes: vals["sizeBytes"],
            createdAt: new Date(),
            deletedAt: null,
          }]),
        };
      }),
    }));

    const svc = new FilesService(db as unknown as Db, makeAccess(), mockAudit, makeStorage());
    await svc.uploadFile(makeUser("org-1", 42), 1, {
      fileName: "report.pdf",
      mimeType: "application/pdf",
      contentBase64,
    });

    expect(capturedValues?.["uploadedByMembershipId"]).toBe(42);
    expect(capturedValues?.["orgId"]).toBe("org-1");
    expect(capturedValues?.["projectId"]).toBe(1);
  });

  it("throws NotFoundException when project is not in the caller's org", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue(undefined);
    db.select.mockReturnValueOnce(makeSelectChain([]));
    const svc = new FilesService(db as unknown as Db, makeAccess(), mockAudit, makeStorage());

    await expect(
      svc.uploadFile(makeUser("org-attacker", 99), 1, {
        fileName: "attack.pdf",
        mimeType: "application/pdf",
        contentBase64: "JVBER",
      }),
    ).rejects.toThrow(NotFoundException);
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe("FilesService.softDeleteFile — soft-delete and author ownership", () => {
  it("throws NotFoundException when file belongs to a different org", async () => {
    const db = makeMockDb();
    db.select.mockReturnValueOnce(makeSelectChain([]));
    const svc = new FilesService(db as unknown as Db, makeAccess(), mockAudit, makeStorage());

    await expect(svc.softDeleteFile(makeUser("org-attacker"), 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("allows the uploader to delete their own file", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    db.select
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(
        makeSelectChain([{ id: 5, uploadedByMembershipId: 7, storageKey: "build/1/files/f.pdf" }]),
      );
    const updateChain = { set: jest.fn().mockReturnThis(), where: jest.fn().mockResolvedValue(undefined) };
    db.update.mockReturnValue(updateChain);

    const svc = new FilesService(db as unknown as Db, makeAccess(), mockAudit, makeStorage());
    await svc.softDeleteFile(makeUser("org-1", 7), 1, 5);

    expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ deletedAt: expect.any(Date) }));
  });

  it("rejects a non-uploader without build:files:manage from deleting another member's file", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    db.select
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(
        makeSelectChain([{ id: 5, uploadedByMembershipId: 99, storageKey: "build/1/files/f.pdf" }]),
      );
    const svc = new FilesService(db as unknown as Db, makeAccess(new Set()), mockAudit, makeStorage());

    await expect(svc.softDeleteFile(makeUser("org-1", 7), 1, 5)).rejects.toThrow(ForbiddenException);
  });

  it("checks project access before loading the file so a manage key cannot delete across inaccessible projects", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    db.select.mockReturnValue(makeSelectChain([]));
    const svc = new FilesService(
      db as unknown as Db,
      makeAccess(new Set(["build:files:manage"])),
      mockAudit,
      makeStorage(),
    );

    await expect(svc.softDeleteFile(makeUser("org-1", 7), 1, 5)).rejects.toThrow(ForbiddenException);
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("FilesService.getSignedUrl — access gate", () => {
  it("returns a signed URL for a file the caller can access", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    db.select
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(
        makeSelectChain([{ id: 3, uploadedByMembershipId: 7, storageKey: "build/1/files/f.pdf" }]),
      );
    const storage = makeStorage();
    const svc = new FilesService(db as unknown as Db, makeAccess(), mockAudit, storage);

    const result = await svc.getSignedUrl(makeUser("org-1", 7), 1, 3);
    expect(result.url).toBe("https://cdn.example.com/signed");
    expect(result.expiresIn).toBe(3600);
  });

  it("throws ForbiddenException for a non-member trying to get a signed URL", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    db.select
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]));
    const svc = new FilesService(db as unknown as Db, makeAccess(), mockAudit, makeStorage());

    await expect(svc.getSignedUrl(makeUser("org-1"), 1, 3)).rejects.toThrow(ForbiddenException);
  });
});
