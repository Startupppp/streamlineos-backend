jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn().mockImplementation(
    async (_db: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { StorageController } from "./storage.controller";
import { MediaTransformRunner } from "./media-transform.runner";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";

const dialect = new PgDialect();
const ORG = "org-a";
const CHAT_KEY = `${ORG}/chat/2f1c9d0e-4a7b-4c1e-9f3a-8b6d5e2c1a09-payroll-leak.pdf`;
const PLAIN_KEY = "uploads/plain.pdf";

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
  return {
    setHeader: jest.fn(),
    json: jest.fn(),
    status: jest.fn().mockReturnThis(),
    end: jest.fn(),
  } as unknown as import("express").Response;
}

function build(attachment: { orgId: string } | null) {
  const chatAttachmentsFindFirst = jest.fn().mockResolvedValue(attachment);
  const untracked = { findFirst: jest.fn().mockResolvedValue(null) };
  const db = {
    query: {
      chatAttachments: { findFirst: chatAttachmentsFindFirst },
      documents: untracked,
      onboardingDocuments: untracked,
      expenses: untracked,
      reimbursements: untracked,
      handbookVersions: untracked,
      payslipPublications: untracked,
      candidateDocumentsVault: untracked,
    },
  };
  const storage = {
    isConfigured: jest.fn().mockReturnValue(true),
    isValidFileKey: jest.fn().mockReturnValue(true),
    getFileKeyFromUrl: jest.fn((value: string) => value),
    getMimeType: jest.fn().mockReturnValue("application/pdf"),
    getFileStream: jest.fn().mockResolvedValue({
      body: { on: jest.fn(), pipe: jest.fn() },
      contentType: "application/pdf",
      contentLength: 10,
    }),
    getFileUrl: jest.fn().mockResolvedValue("https://signed.example.com/file"),
  };
  const controller = new StorageController(
    db as never,
    storage as never,
    { log: jest.fn() } as never,
    { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as never,
    { scan: jest.fn() } as never,
    { isKeyBlocked: jest.fn().mockResolvedValue(false) } as never,
    new MediaTransformRunner(),
  );
  return { controller, storage, chatAttachmentsFindFirst };
}

function renderedWhere(findFirst: jest.Mock): string {
  const [args] = findFirst.mock.calls[0] as [{ where: SQL }];
  return dialect.sqlToQuery(args.where).sql;
}

describe("storage generic read — a chat attachment key is refused", () => {
  it("DENY: /storage/download 404s a tracked same-org chat attachment key", async () => {
    const { controller, storage } = build({ orgId: ORG });

    await expect(
      controller.download({ key: CHAT_KEY, expiresIn: 3600 }, ctx(ORG), mockRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.getFileUrl).not.toHaveBeenCalled();
  });

  it("DENY: the refusal is 404, never 403 — a 403 would confirm a private channel holds the file", async () => {
    const { controller } = build({ orgId: ORG });

    await expect(
      controller.download({ key: CHAT_KEY, expiresIn: 3600 }, ctx(ORG), mockRes()),
    ).rejects.not.toBeInstanceOf(ForbiddenException);
  });

  it("DENY: /storage/download?attachment=1 never opens the byte stream", async () => {
    const { controller, storage } = build({ orgId: ORG });

    await expect(
      controller.download(
        { key: CHAT_KEY, expiresIn: 3600, attachment: "1" },
        ctx(ORG),
        mockRes(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.getFileStream).not.toHaveBeenCalled();
  });

  it("DENY: /storage/image 404s the same key and never opens the byte stream", async () => {
    const { controller, storage } = build({ orgId: ORG });

    await expect(
      controller.image({ key: CHAT_KEY }, ctx(ORG), mockRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.getFileStream).not.toHaveBeenCalled();
  });

  it("the lookup binds the requested key, so the refusal is a resolution and not a blanket ban on the folder", async () => {
    const { controller, chatAttachmentsFindFirst } = build({ orgId: ORG });

    await expect(
      controller.download({ key: CHAT_KEY, expiresIn: 3600 }, ctx(ORG), mockRes()),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(chatAttachmentsFindFirst).toHaveBeenCalledTimes(1);
    expect(renderedWhere(chatAttachmentsFindFirst)).toMatch(
      /"chat_attachments"\."file_key"\s*=\s*\$/i,
    );
  });

  it("CONTROL: an untracked non-chat key is still served, so the denial is not universal", async () => {
    const { controller } = build(null);
    const res = mockRes();

    await controller.download({ key: PLAIN_KEY, expiresIn: 3600 }, ctx(ORG), res);

    expect(res.json).toHaveBeenCalledWith({ url: "https://signed.example.com/file" });
  });

  it("CONTROL: a chat key with no attachment row is a composer upload whose message was never sent, and stays readable", async () => {
    const { controller } = build(null);
    const res = mockRes();

    await controller.download({ key: CHAT_KEY, expiresIn: 3600 }, ctx(ORG), res);

    expect(res.json).toHaveBeenCalledWith({ url: "https://signed.example.com/file" });
  });
});
