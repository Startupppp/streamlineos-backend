import { NotFoundException } from "@nestjs/common";
import { StorageController } from "./storage.controller";
import { MediaTransformRunner } from "./media-transform.runner";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";

const ORG_A = "3f2a9c14-5b7e-4d81-9a02-6c8e1f4b7d33";
const ORG_B = "9c81d0a5-2e64-4f37-b1c8-7d5a3e2f9b40";

function ctx(orgId: string): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "EMPLOYEE",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function mockRes() {
  const headers = new Map<string, string>();
  const res = {
    setHeader: jest.fn((name: string, value: string) => {
      headers.set(name.toLowerCase(), value);
    }),
    json: jest.fn(),
    status: jest.fn().mockReturnThis(),
    end: jest.fn(),
  };
  return { res: res as unknown as import("express").Response, headers };
}

function build(kbAttachment: unknown = { pageId: 7, uploadedById: "user-1" }, kbPage: unknown = { id: 7 }) {
  const findFirst = jest.fn().mockResolvedValue(null);
  const selectChain: Record<string, jest.Mock> = {};
  selectChain["from"] = jest.fn(() => selectChain);
  selectChain["innerJoin"] = jest.fn(() => selectChain);
  selectChain["where"] = jest.fn().mockResolvedValue([]);
  const db = {
    select: jest.fn(() => selectChain),
    query: {
      kbPageAttachments: { findFirst: jest.fn().mockResolvedValue(kbAttachment) },
      kbPages: { findFirst: jest.fn().mockResolvedValue(kbPage) },
      organizationMembers: { findMany: jest.fn().mockResolvedValue([]) },
      documents: { findFirst },
      onboardingDocuments: { findFirst },
      expenses: { findFirst },
      reimbursements: { findFirst },
      handbookVersions: { findFirst },
      payslipPublications: { findFirst },
      candidateDocumentsVault: { findFirst },
    },
  };
  const body = { on: jest.fn(), pipe: jest.fn() };
  const storage = {
    isConfigured: jest.fn().mockReturnValue(true),
    isValidFileKey: jest.fn().mockReturnValue(true),
    getMimeType: jest.fn().mockReturnValue("application/octet-stream"),
    getFileStream: jest
      .fn()
      .mockResolvedValue({ body, contentType: "image/webp", contentLength: 42 }),
  };
  const quarantine = { isKeyBlocked: jest.fn().mockResolvedValue(false) };
  const controller = new StorageController(
    db as never,
    storage as never,
    { log: jest.fn() } as never,
    { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as never,
    { scan: jest.fn() } as never,
    quarantine as never,
    new MediaTransformRunner(),
  );
  return { controller, storage, findFirst, quarantine, body };
}

describe("the bytes an <img> receives", () => {
  it("streams the object with the content type the store reports", async () => {
    const { controller, storage, body } = build();
    const { res, headers } = mockRes();

    await controller.image({ key: `${ORG_A}/uploads/avatar.png` }, ctx(ORG_A), res);

    expect(storage.getFileStream).toHaveBeenCalledWith(
      ORG_A,
      `${ORG_A}/uploads/avatar.png`,
    );
    expect(headers.get("content-type")).toBe("image/webp");
    expect(body.pipe).toHaveBeenCalledWith(res);
  });

  it("is never cacheable by a shared cache — one tenant's image must not be served to another", async () => {
    const { controller } = build();
    const { res, headers } = mockRes();

    await controller.image({ key: `${ORG_A}/uploads/avatar.png` }, ctx(ORG_A), res);

    const cacheControl = headers.get("cache-control") ?? "";
    expect(cacheControl).toContain("private");
    expect(cacheControl).not.toContain("public");
  });
});

describe("a key naming another organisation is refused before anything is read", () => {
  it.each([
    ["an org-prefixed key", `${ORG_B}/uploads/avatar.png`],
    ["an org-namespaced kb-media key", `kb-media/${ORG_B}/cover.webp`],
    ["an org-namespaced kb-sources key", `kb-sources/${ORG_B}/doc.png`],
  ])("404s %s", async (_label, key) => {
    const { controller, storage, findFirst, quarantine } = build();
    const { res } = mockRes();

    await expect(controller.image({ key }, ctx(ORG_A), res)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(storage.getFileStream).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(quarantine.isKeyBlocked).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it("404s an untracked sensitive-prefix key rather than falling through to the bucket", async () => {
    const { controller, storage } = build();
    const { res } = mockRes();

    await expect(
      controller.image({ key: "payroll/unregistered.png" }, ctx(ORG_A), res),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.getFileStream).not.toHaveBeenCalled();
  });

  it("serves the caller's own organisation when the page behind the key is visible (control)", async () => {
    const { controller, storage } = build();
    const { res } = mockRes();

    await controller.image({ key: `kb-media/${ORG_A}/cover.webp` }, ctx(ORG_A), res);

    expect(storage.getFileStream).toHaveBeenCalledWith(
      ORG_A,
      `kb-media/${ORG_A}/cover.webp`,
    );
  });

  it("refuses a kb-media key whose page the caller cannot see, even inside their own org", async () => {
    const { controller, storage } = build({ pageId: 7, uploadedById: "someone-else" }, null);
    const { res } = mockRes();

    await expect(
      controller.image({ key: `kb-media/${ORG_A}/cover.webp` }, ctx(ORG_A), res),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.getFileStream).not.toHaveBeenCalled();
  });

  it("refuses a kb-media key with no attachment row — an orphaned object is not readable", async () => {
    const { controller, storage } = build(null, null);
    const { res } = mockRes();

    await expect(
      controller.image({ key: `kb-media/${ORG_A}/orphan.webp` }, ctx(ORG_A), res),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.getFileStream).not.toHaveBeenCalled();
  });
});
