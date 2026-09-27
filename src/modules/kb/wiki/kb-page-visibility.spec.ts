import type { Db } from "../../../db/drizzle.module";
import { KbPagePublicService } from "./kb-page-public.service";
import { KbPageWriterService } from "./kb-page-writer.service";
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
  return new KbPagePublicService(db, {} as never, {} as never, new KbPageWriterService({} as never));
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

    expect(setValues[0]).toHaveProperty("publicToken", null);
    expect(setValues[0]).toHaveProperty("visibility", "private");
  });

  it("clears both token columns when a shared page leaves public, so the link stops resolving instead of lying dormant", async () => {
    const { db, setValues } = makeDb("already-shared-token");

    await makeService(db).setVisibility(makeUser(), 1, "private", false);

    expect(setValues[0]).toHaveProperty("publicToken", null);
    expect(setValues[0]).toHaveProperty("publicTokenHash", null);
  });

  it("clears the token for org visibility too, because org-wide is not public and must not keep an anonymous credential alive", async () => {
    const { db, setValues } = makeDb("already-shared-token");

    await makeService(db).setVisibility(makeUser(), 1, "org", false);

    expect(setValues[0]).toHaveProperty("publicToken", null);
    expect(setValues[0]).toHaveProperty("publicTokenHash", null);
  });

  it("mints a different token when a revoked page is shared again, so the old URL is not resurrected", async () => {
    const revoked = makeDb("already-shared-token");
    await makeService(revoked.db).setVisibility(makeUser(), 1, "private", false);
    expect(revoked.setValues[0]).toHaveProperty("publicToken", null);

    const reshared = makeDb(null);
    await makeService(reshared.db).setVisibility(makeUser(), 1, "public", false);

    const minted = reshared.setValues[0] as { publicToken?: string };
    expect(typeof minted.publicToken).toBe("string");
    expect(minted.publicToken).not.toBe("already-shared-token");
  });
});

describe("KbPagesService.setVisibility — public share token revision", () => {
  it("bumps the revision when minting a new token, so CDN caches are invalidated on first share", async () => {
    const { db, setValues } = makeDb(null);

    await makeService(db).setVisibility(makeUser(), 1, "public", false);

    expect(setValues[0]).toHaveProperty("publicTokenRevision");
  });

  it("bumps the revision when revoking a share, so CDN caches cannot keep serving a page that is no longer public", async () => {
    const { db, setValues } = makeDb("existing-token");

    await makeService(db).setVisibility(makeUser(), 1, "private", false);

    expect(setValues[0]).toHaveProperty("publicTokenRevision");
  });

  it("bumps the revision when clearing a shared page to org visibility, so the CDN does not serve stale content", async () => {
    const { db, setValues } = makeDb("existing-token");

    await makeService(db).setVisibility(makeUser(), 1, "org", false);

    expect(setValues[0]).toHaveProperty("publicTokenRevision");
  });

  it("does not bump the revision when the page is already public with an existing token, so stable shares have a stable ETag", async () => {
    const { db, setValues } = makeDb("existing-token");

    await makeService(db).setVisibility(makeUser(), 1, "public", false);

    expect(setValues[0]).not.toHaveProperty("publicTokenRevision");
  });
});
