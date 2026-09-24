import type { Db } from "../../../db/drizzle.module";
import { KbPagesService } from "./kb-pages.service";
import { hashPublicToken } from "./kb-public-token";

const ORG = "org-a";

function makeUser() {
  return {
    orgId: ORG,
    userId: "u1",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 1, isOrgOwner: false },
  } as never;
}

function makeDb(existingPublicToken: string | null) {
  const setValues: Record<string, unknown>[] = [];

  const returningMock = jest
    .fn()
    .mockResolvedValue([{ id: 1, contentRevision: 1, aclRevision: 2 }]);

  const tx = {
    update: jest.fn(() => ({
      set: jest.fn((values: Record<string, unknown>) => {
        setValues.push(values);
        return { where: jest.fn(() => ({ returning: returningMock })) };
      }),
    })),
    insert: jest.fn(() => ({
      values: jest.fn().mockResolvedValue([]),
      onConflictDoNothing: jest.fn().mockResolvedValue([]),
    })),
  };

  const db = {
    query: {
      kbPages: {
        findFirst: jest.fn().mockResolvedValue({
          id: 1,
          createdById: "u1",
          createdByMembershipId: null,
          visibility: "private",
          publicToken: existingPublicToken,
        }),
      },
    },
    transaction: jest.fn((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as Db;

  return { db, setValues };
}

function makeService(db: Db) {
  return new KbPagesService(db, {} as never, {} as never, {} as never, {} as never);
}

describe("KbPagesService.setVisibility — public share tokens", () => {
  it("writes a public_token_hash alongside the token, because the public read resolves shares by hash", async () => {
    const { db, setValues } = makeDb(null);

    await makeService(db).setVisibility(makeUser(), 1, "public", false);

    const values = setValues[0] as { publicToken?: string; publicTokenHash?: string };
    expect(typeof values.publicToken).toBe("string");
    expect(values.publicTokenHash).toBe(hashPublicToken(values.publicToken as string));
  });

  it("stores a hash that differs from the stored token, so a database read alone does not yield the bearer credential", async () => {
    const { db, setValues } = makeDb(null);

    await makeService(db).setVisibility(makeUser(), 1, "public", false);

    const values = setValues[0] as { publicToken?: string; publicTokenHash?: string };
    expect(values.publicTokenHash).not.toBe(values.publicToken);
  });

  it("does not mint a second token for a page that already has one, so an existing share link keeps working", async () => {
    const { db, setValues } = makeDb("already-shared-token");

    await makeService(db).setVisibility(makeUser(), 1, "public", false);

    expect(setValues[0]).not.toHaveProperty("publicToken");
    expect(setValues[0]).not.toHaveProperty("publicTokenHash");
  });

  it("mints no token at all when the page is made private, so unsharing cannot hand out a fresh credential", async () => {
    const { db, setValues } = makeDb(null);

    await makeService(db).setVisibility(makeUser(), 1, "private", false);

    expect(setValues[0]).not.toHaveProperty("publicToken");
    expect(setValues[0]).toHaveProperty("visibility", "private");
  });
});
