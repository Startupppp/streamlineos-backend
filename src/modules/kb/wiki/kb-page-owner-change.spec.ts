import { ForbiddenException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPagesService } from "./kb-pages.service";
import { KbPageWriterService } from "./kb-page-writer.service";

jest.mock("./kb-page-edit.util", () => ({
  ...jest.requireActual("./kb-page-edit.util"),
  snapshotIfNeeded: jest.fn().mockResolvedValue(undefined),
  resyncPageLinks: jest.fn().mockResolvedValue(undefined),
}));

const emitMock = jest.fn().mockResolvedValue(undefined);
jest.mock("../../../common/outbox/outbox-writer", () => ({
  OutboxWriter: { emit: (...args: unknown[]) => emitMock(...args) },
}));

const PAGE_ID = 42;
const ORG_ID = "org-owner-change";
const NEW_OWNER_USER_ID = "user-new-owner";
const NEW_OWNER_MEMBERSHIP_ID = 9;

function makeUser() {
  return {
    orgId: ORG_ID,
    userId: "user-actor",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 1 },
  } as never;
}

function makePageRow(over: Record<string, unknown> = {}) {
  return {
    id: PAGE_ID,
    orgId: ORG_ID,
    isLocked: false,
    trustState: "unverified",
    content: null,
    ...over,
  };
}

function makeDb(pageRow: unknown, updatedRow: unknown) {
  const setCalls: unknown[] = [];

  const returningFn = jest.fn().mockResolvedValue([updatedRow]);
  const whereFn = jest.fn().mockReturnValue({ returning: returningFn });
  const setFn = jest.fn().mockImplementation((values: unknown) => {
    setCalls.push(values);
    return { where: whereFn };
  });
  const updateFn = jest.fn().mockReturnValue({ set: setFn });

  const tx = {
    update: updateFn,
    query: {
      kbPages: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
  };

  const db = {
    query: {
      kbPages: { findFirst: jest.fn().mockResolvedValue(pageRow) },
      kbSpaces: { findFirst: jest.fn().mockResolvedValue(undefined) },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: NEW_OWNER_MEMBERSHIP_ID }),
      },
    },
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as Db;

  return { db, setCalls };
}

function makeAuth() {
  return {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest
      .fn()
      .mockResolvedValue({ orgId: ORG_ID, pageId: PAGE_ID, action: "edit", via: "admin" }),
  };
}

const notifications = {} as never;
const planLimits = {} as never;

describe("KbPagesService.update — ownerUserId reassignment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    emitMock.mockResolvedValue(undefined);
  });

  it("rejects an ownership change from a caller who is not a manager", async () => {
    const pageRow = makePageRow();
    const { db } = makeDb(pageRow, { ...pageRow, ownerUserId: NEW_OWNER_USER_ID });
    const auth = makeAuth();
    const audit = { log: jest.fn() };
    const svc = new KbPagesService(
      db,
      planLimits,
      auth as never,
      {} as never,
      audit as never,
      new KbPageWriterService({} as never),
    );

    await expect(
      svc.update(makeUser(), PAGE_ID, { ownerUserId: NEW_OWNER_USER_ID }, false),
    ).rejects.toThrow(ForbiddenException);

    expect(audit.log).not.toHaveBeenCalled();
  });

  it("allows an ownership change from a manager, bumps acl_revision, reindexes, and audits it", async () => {
    const pageRow = makePageRow();
    const updatedRow = {
      ...pageRow,
      ownerUserId: NEW_OWNER_USER_ID,
      ownerMembershipId: NEW_OWNER_MEMBERSHIP_ID,
      aclRevision: 2,
      contentRevision: 1,
    };
    const { db, setCalls } = makeDb(pageRow, updatedRow);
    const auth = makeAuth();
    const audit = { log: jest.fn() };
    const svc = new KbPagesService(
      db,
      planLimits,
      auth as never,
      {} as never,
      audit as never,
      new KbPageWriterService({} as never),
    );

    const result = await svc.update(
      makeUser(),
      PAGE_ID,
      { ownerUserId: NEW_OWNER_USER_ID },
      true,
    );

    expect(result.ownerUserId).toBe(NEW_OWNER_USER_ID);

    const setValues = setCalls[0] as Record<string, unknown>;
    expect(setValues).toHaveProperty("ownerUserId", NEW_OWNER_USER_ID);
    expect(setValues).toHaveProperty("ownerMembershipId", NEW_OWNER_MEMBERSHIP_ID);
    expect(setValues).toHaveProperty("aclRevision");

    expect(emitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "kb.content.index" }),
    );

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "kb.page.owner_changed",
        resourceType: "kb_page",
        resourceId: String(PAGE_ID),
      }),
    );
  });

  it("does not touch acl_revision or fire a reindex for an update with no ownerUserId or spaceId field", async () => {
    const pageRow = makePageRow();
    const updatedRow = { ...pageRow, title: "New title" };
    const { db, setCalls } = makeDb(pageRow, updatedRow);
    const auth = makeAuth();
    const audit = { log: jest.fn() };
    const svc = new KbPagesService(
      db,
      planLimits,
      auth as never,
      {} as never,
      audit as never,
      new KbPageWriterService({} as never),
    );

    await svc.update(makeUser(), PAGE_ID, { title: "New title" }, false);

    const setValues = setCalls[0] as Record<string, unknown>;
    expect(setValues).not.toHaveProperty("aclRevision");
    expect(emitMock).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});
