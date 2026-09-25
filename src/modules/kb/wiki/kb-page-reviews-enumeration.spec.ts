import { NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPageReviewsService } from "./kb-page-reviews.service";

function makeUser(orgId = "org-1") {
  return {
    orgId,
    userId: "user-1",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 1 },
  } as never;
}

function makeDb(pageRow: unknown) {
  return {
    query: {
      kbPages: { findFirst: jest.fn().mockResolvedValue(pageRow) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
    },
  } as unknown as Db;
}

const audit = { log: jest.fn() } as never;
const dispatch = { emit: jest.fn() } as never;
const access = { holds: jest.fn().mockResolvedValue(false) } as never;

describe("KbPageReviewsService.create — enumeration guard", () => {
  const PAGE_ID = 42;
  const input = { type: "general" } as never;

  function makeAuth(throws: boolean) {
    return {
      assertPageAccess: throws
        ? jest.fn().mockRejectedValue(new NotFoundException("Page not found"))
        : jest.fn().mockResolvedValue(undefined),
      visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    };
  }

  it("throws NotFoundException when the page does not exist", async () => {
    const auth = makeAuth(true);
    const svc = new KbPageReviewsService(makeDb(null), audit, dispatch, access, auth as never);

    const error = await svc.create(makeUser(), PAGE_ID, input).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Page not found");
  });

  it("throws the same exception when the page exists but is access-denied", async () => {
    const auth = makeAuth(true);
    const db = makeDb({ id: PAGE_ID, title: "Secret page" });
    const svc = new KbPageReviewsService(db, audit, dispatch, access, auth as never);

    const error = await svc.create(makeUser(), PAGE_ID, input).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Page not found");
    expect(auth.assertPageAccess).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
      PAGE_ID,
      "view",
    );
  });

  it("nonexistent-page error and restricted-page error are byte-for-byte identical", async () => {
    const errorA = await new KbPageReviewsService(
      makeDb(null),
      audit,
      dispatch,
      access,
      makeAuth(true) as never,
    ).create(makeUser(), PAGE_ID, input).catch((e: unknown) => e);

    const errorB = await new KbPageReviewsService(
      makeDb({ id: PAGE_ID, title: "Restricted" }),
      audit,
      dispatch,
      access,
      makeAuth(true) as never,
    ).create(makeUser(), PAGE_ID, input).catch((e: unknown) => e);

    expect((errorA as NotFoundException).message).toBe((errorB as NotFoundException).message);
    expect((errorA as NotFoundException).getStatus()).toBe((errorB as NotFoundException).getStatus());
  });
});
