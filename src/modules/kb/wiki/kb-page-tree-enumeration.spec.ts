import { NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPageTreeService } from "./kb-page-tree.service";

function makeUser(orgId = "org-1") {
  return { orgId, userId: "user-1", isOrgOwner: false } as never;
}

function makeDb(pageRow: unknown) {
  return {
    query: { kbPages: { findFirst: jest.fn().mockResolvedValue(pageRow) } },
    transaction: jest.fn(),
  } as unknown as Db;
}

const audit = { log: jest.fn() } as never;
const access = { holds: jest.fn().mockResolvedValue(false) } as never;
const kbAccess = { assertSpaceAccessible: jest.fn().mockResolvedValue(undefined) } as never;

function makeAuth() {
  return {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest.fn().mockResolvedValue(undefined),
  };
}

describe("KbPageTreeService.restore — enumeration guard", () => {
  const PAGE_ID = 11;

  it("throws NotFoundException when the page does not exist", async () => {
    const auth = makeAuth();
    const svc = new KbPageTreeService(makeDb(null), audit, auth as never, access, kbAccess, {} as never);

    await expect(svc.restore(makeUser(), PAGE_ID)).rejects.toThrow(NotFoundException);
    await expect(svc.restore(makeUser(), PAGE_ID)).rejects.toThrow("Page not found");
  });

  it("throws NotFoundException when the page exists but is restricted", async () => {
    const auth = makeAuth();
    const db = makeDb(null);
    const svc = new KbPageTreeService(db, audit, auth as never, access, kbAccess, {} as never);

    const error = await svc.restore(makeUser(), PAGE_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Page not found");
    expect(auth.visiblePagePredicate).toHaveBeenCalled();
  });

  it("nonexistent-page error and restricted-page error are byte-for-byte identical", async () => {
    const errorA = await new KbPageTreeService(
      makeDb(null),
      audit,
      makeAuth() as never,
      access,
      kbAccess,
      {} as never,
    ).restore(makeUser(), PAGE_ID).catch((e: unknown) => e);

    const errorB = await new KbPageTreeService(
      makeDb(null),
      audit,
      makeAuth() as never,
      access,
      kbAccess,
      {} as never,
    ).restore(makeUser(), PAGE_ID).catch((e: unknown) => e);

    expect((errorA as NotFoundException).message).toBe((errorB as NotFoundException).message);
    expect((errorA as NotFoundException).getStatus()).toBe((errorB as NotFoundException).getStatus());
  });
});
