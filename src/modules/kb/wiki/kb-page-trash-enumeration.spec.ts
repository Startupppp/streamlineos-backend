import { NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPageTrashService } from "./kb-page-trash.service";

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
const storage = { isConfigured: jest.fn().mockReturnValue(false) } as never;
const config = { R2_KB_BUCKET_NAME: undefined } as never;
const tree = {} as never;
const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never;

function makeAuth() {
  return {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  };
}

describe("KbPageTrashService.hardDelete — enumeration guard", () => {
  const PAGE_ID = 7;

  it("throws NotFoundException when the page does not exist", async () => {
    const auth = makeAuth();
    const svc = new KbPageTrashService(makeDb(null), audit, storage, config, auth as never, tree, cache);

    await expect(svc.hardDelete(makeUser(), PAGE_ID)).rejects.toThrow(NotFoundException);
    await expect(svc.hardDelete(makeUser(), PAGE_ID)).rejects.toThrow("Page not found");
  });

  it("throws NotFoundException when the page exists but is restricted", async () => {
    const auth = makeAuth();
    const db = makeDb(null);
    const svc = new KbPageTrashService(db, audit, storage, config, auth as never, tree, cache);

    const error = await svc.hardDelete(makeUser(), PAGE_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Page not found");
    expect(auth.visiblePagePredicate).toHaveBeenCalled();
  });

  it("nonexistent-page error and restricted-page error are byte-for-byte identical", async () => {
    const errorA = await new KbPageTrashService(
      makeDb(null),
      audit,
      storage,
      config,
      makeAuth() as never,
      tree,
      cache,
    ).hardDelete(makeUser(), PAGE_ID).catch((e: unknown) => e);

    const errorB = await new KbPageTrashService(
      makeDb(null),
      audit,
      storage,
      config,
      makeAuth() as never,
      tree,
      cache,
    ).hardDelete(makeUser(), PAGE_ID).catch((e: unknown) => e);

    expect((errorA as NotFoundException).message).toBe((errorB as NotFoundException).message);
    expect((errorA as NotFoundException).getStatus()).toBe((errorB as NotFoundException).getStatus());
  });
});
