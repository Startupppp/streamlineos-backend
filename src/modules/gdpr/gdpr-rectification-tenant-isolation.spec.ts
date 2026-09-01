import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { GdprRectificationService } from "./gdpr-rectification.service";

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";
const SUBJECT = "user-subject";

function renderedWhere(condition: unknown): string {
  return new PgDialect().sqlToQuery(condition as SQL).sql;
}

function buildTx(membershipHit: boolean) {
  const captured: unknown[] = [];
  let selectIndex = 0;
  const tx = {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((condition: unknown) => {
          captured.push(condition);
          const first = selectIndex++ === 0;
          const rows =
            first && membershipHit
              ? [{ id: 1, status: "ACTIVE" }]
              : first
                ? []
                : [{ id: SUBJECT, name: "Original Name" }];
          return { limit: jest.fn().mockResolvedValue(rows) };
        }),
      }),
    })),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ name: "New Name" }]),
        }),
      }),
    }),
    insert: jest
      .fn()
      .mockReturnValueOnce({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 99 }]),
        }),
      })
      .mockReturnValueOnce({ values: jest.fn().mockResolvedValue(undefined) }),
  };
  const db = {
    transaction: jest.fn(
      (cb: (t: typeof tx) => unknown) => cb(tx),
    ),
  } as unknown as Db;
  return { db, captured };
}

describe("GdprRectificationService — cross-tenant isolation", () => {
  it("refuses to rectify when the subject is not found in the attacker org", async () => {
    const { db } = buildTx(false);
    const svc = new GdprRectificationService(db);

    await expect(
      svc.rectifyOwnProfile(ATTACKER_ORG, SUBJECT, { field: "profile.name", value: "New Name" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("binds org_id in the membership lookup so a different-org subject cannot be reached", async () => {
    const { db, captured } = buildTx(false);
    const svc = new GdprRectificationService(db);

    await svc
      .rectifyOwnProfile(ATTACKER_ORG, SUBJECT, { field: "profile.name", value: "New Name" })
      .catch(() => null);

    expect(captured.length).toBeGreaterThan(0);
    const rendered = renderedWhere(captured[0]);
    expect(rendered).toContain("org_id");
  });

  it("same-tenant control: a correct org with active membership completes rectification", async () => {
    const { db } = buildTx(true);
    const svc = new GdprRectificationService(db);

    const result = await svc.rectifyOwnProfile(OWNER_ORG, SUBJECT, {
      field: "profile.name",
      value: "New Name",
    });

    expect(result.status).toBe("completed");
    expect(result.changed).toBe(true);
  });

  it("where-clause never contains the owner org's id when called with the attacker org", async () => {
    const { db, captured } = buildTx(false);
    const svc = new GdprRectificationService(db);

    await svc
      .rectifyOwnProfile(ATTACKER_ORG, SUBJECT, { field: "profile.name", value: "New Name" })
      .catch(() => null);

    const combined = captured.map((c) => renderedWhere(c)).join(" ");
    expect(combined).not.toContain(OWNER_ORG);
  });
});
