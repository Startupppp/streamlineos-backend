process.env.APP_URL ??= "http://localhost:1000";

import { NotFoundException } from "@nestjs/common";
import * as applyScopeModule from "../../access/apply-scope";
import {
  runWithTenantContext,
  type AfterCommitHook,
  type TenantContext,
} from "../../../common/tenant/tenant-context";
import { onboardingDocuments, users } from "../../../db/schema";
import { OnboardingViewsService } from "./onboarding-views.service";

function selectLimit(rows: unknown[]) {
  const chain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

describe("OnboardingViewsService scope and atomic writes", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns an empty filtered list instead of revealing a team-external target", async () => {
    const rowsChain = {
      from: jest.fn(),
      innerJoin: jest.fn(),
      leftJoin: jest.fn(),
      where: jest.fn(),
      orderBy: jest.fn(),
      limit: jest.fn(),
      offset: jest.fn().mockResolvedValue([]),
    };
    rowsChain.from.mockReturnValue(rowsChain);
    rowsChain.innerJoin.mockReturnValue(rowsChain);
    rowsChain.leftJoin.mockReturnValue(rowsChain);
    rowsChain.where.mockReturnValue(rowsChain);
    rowsChain.orderBy.mockReturnValue(rowsChain);
    rowsChain.limit.mockReturnValue(rowsChain);
    const countChain = {
      from: jest.fn(),
      where: jest.fn().mockResolvedValue([{ total: 0 }]),
    };
    countChain.from.mockReturnValue(countChain);
    const db = {
      select: jest
        .fn()
        .mockReturnValueOnce(rowsChain)
        .mockReturnValueOnce(countChain),
    };
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = new OnboardingViewsService(
      db as never,
      { runAutomationsForEvent: jest.fn() } as never,
    );

    await expect(
      service.list(
        "org-1",
        "actor-1",
        true,
        { page: 1, limit: 20, userId: "other-user" },
        "team",
      ),
    ).resolves.toMatchObject({ data: [], pagination: { total: 0 } });
    expect(scopeSpy).toHaveBeenCalledWith(
      "team",
      "org-1",
      "actor-1",
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
  });

  it("resolves a file reference only through the caller's record scope", async () => {
    const db = {
      select: jest.fn().mockReturnValue(
        selectLimit([
          { id: 7, fileUrl: "onboarding-docs/private.pdf", fileName: "private.pdf" },
        ]),
      ),
    };
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = new OnboardingViewsService(
      db as never,
      { runAutomationsForEvent: jest.fn() } as never,
    );

    await expect(
      service.getFileReference("org-1", "actor-1", 7, "own"),
    ).resolves.toEqual({
      id: 7,
      fileUrl: "onboarding-docs/private.pdf",
      fileName: "private.pdf",
    });
    expect(scopeSpy).toHaveBeenCalledWith(
      "own",
      "org-1",
      "actor-1",
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
  });

  it("refuses an on-behalf upload when the target is outside membership scope", async () => {
    const tx = {
      select: jest.fn().mockReturnValue(selectLimit([])),
      insert: jest.fn(),
    };
    const db = {
      transaction: jest.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = new OnboardingViewsService(
      db as never,
      { runAutomationsForEvent: jest.fn() } as never,
    );

    await expect(
      service.create(
        "org-1",
        "actor-1",
        true,
        {
          documentTypeId: 1,
          fileUrl: "https://example.com/doc.pdf",
          fileName: "doc.pdf",
          targetUserId: "other-user",
        },
        "team",
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(scopeSpy).toHaveBeenCalledWith(
      "team",
      "org-1",
      "actor-1",
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("refuses review when the document owner is outside scope", async () => {
    const tx = {
      select: jest.fn().mockReturnValue(selectLimit([])),
      update: jest.fn(),
      insert: jest.fn(),
    };
    const db = {
      transaction: jest.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    const service = new OnboardingViewsService(
      db as never,
      { runAutomationsForEvent: jest.fn() } as never,
    );

    await expect(
      service.review(
        "org-1",
        "actor-1",
        9,
        { status: "APPROVED" },
        "own",
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("dispatches document automation only after the request transaction commits", async () => {
    const document = {
      id: 17,
      orgId: "org-1",
      userId: "employee-1",
      documentTypeId: 1,
      version: 1,
      status: "SUBMITTED",
    };
    const select = jest
      .fn()
      .mockReturnValueOnce(selectLimit([{ userId: "employee-1" }]))
      .mockReturnValueOnce(selectLimit([{ id: 1, name: "ID proof" }]))
      .mockReturnValueOnce(selectLimit([]));
    const documentValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([document]),
    });
    const auditValues = jest.fn().mockResolvedValue(undefined);
    const insert = jest
      .fn()
      .mockReturnValueOnce({ values: documentValues })
      .mockReturnValueOnce({ values: auditValues });
    const tx = {
      select,
      insert,
      execute: jest.fn().mockResolvedValue(undefined),
    };
    const db = {
      transaction: jest.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    const runAutomationsForEvent = jest.fn().mockResolvedValue(undefined);
    const service = new OnboardingViewsService(
      db as never,
      { runAutomationsForEvent } as never,
    );
    const afterCommit: AfterCommitHook[] = [];
    const context = {
      orgId: "org-1",
      audience: "INTERNAL",
      tx: tx as never,
      afterCommit,
    } as TenantContext;

    await expect(
      runWithTenantContext(context, () =>
        service.create(
          "org-1",
          "employee-1",
          false,
          {
            documentTypeId: 1,
            fileUrl: "https://example.com/doc.pdf",
            fileName: "doc.pdf",
          },
          "own",
        ),
      ),
    ).resolves.toEqual(document);

    expect(runAutomationsForEvent).not.toHaveBeenCalled();
    expect(afterCommit).toHaveLength(1);
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(documentValues).toHaveBeenCalledWith(
      expect.objectContaining({ version: expect.anything() }),
    );

    await afterCommit[0]?.();

    expect(runAutomationsForEvent).toHaveBeenCalledWith(
      "org-1",
      "onboarding.document_submitted",
      expect.objectContaining({ documentId: 17, userId: "employee-1" }),
    );
  });

  it("reviews and audits atomically without updating the global user status", async () => {
    const select = jest.fn().mockReturnValue(
      selectLimit([{ id: 9, userId: "employee-1", status: "SUBMITTED" }]),
    );
    const returning = jest
      .fn()
      .mockResolvedValue([{ id: 9, status: "APPROVED" }]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const update = jest.fn().mockReturnValue({ set });
    const auditValues = jest.fn().mockResolvedValue(undefined);
    const insert = jest.fn().mockReturnValue({ values: auditValues });
    const tx = { select, update, insert };
    const db = {
      transaction: jest.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    const service = new OnboardingViewsService(
      db as never,
      { runAutomationsForEvent: jest.fn() } as never,
    );

    await expect(
      service.review(
        "org-1",
        "reviewer-1",
        9,
        { status: "APPROVED", remarks: "Verified" },
        "all",
      ),
    ).resolves.toEqual({ id: 9, status: "APPROVED" });

    expect(update).toHaveBeenCalledWith(onboardingDocuments);
    expect(update.mock.calls.some(([table]) => table === users)).toBe(false);
    expect(auditValues).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        onboardingDocumentId: 9,
        performedBy: "reviewer-1",
        action: "APPROVED",
      }),
    );
  });
});
