import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { KnowledgeCollectionService } from "./knowledge-collection.service";
import type { KnowledgeAuthorizationService } from "../authorization/knowledge-authorization.service";
import type { KbActorStanding } from "../authorization/knowledge-authorization.types";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { KbPageCollectionQuery } from "./knowledge-collection.types";

const ORG = "org-owner-scope";
const MY_MEMBERSHIP = 42;
const OTHER_ADMIN_MEMBERSHIP = 99;

function standing(overrides: Partial<KbActorStanding> = {}): KbActorStanding {
  return {
    orgId: ORG,
    userId: "user-me",
    membershipId: MY_MEMBERSHIP,
    roleSlugs: ["writer"],
    isOrgOwner: false,
    isKbAdmin: false,
    accessibleSpaceIds: [7],
    accessibleProjectIds: [],
    permissionsVersion: 3,
    ...overrides,
  };
}

function user(): CurrentUserContext {
  return {
    orgId: ORG,
    userId: "user-me",
    role: "MEMBER",
    isOrgOwner: false,
  } as CurrentUserContext;
}

function query(
  overrides: Partial<KbPageCollectionQuery> = {},
): KbPageCollectionQuery {
  return { sort: "updated_desc", limit: 20, ...overrides };
}

interface Capture {
  wheres: SQL[];
  selectCalls: number;
}

function makeChain(
  rows: Record<string, unknown>[],
  capture: Capture,
): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain.orderBy = jest.fn(() => chain);
  chain.limit = jest.fn(() => Object.assign(Promise.resolve(rows), chain));
  chain.groupBy = jest.fn(() => Promise.resolve([]));
  chain.union = jest.fn(() => makeChain(rows, capture));
  return chain;
}

function foreignPrivatePageRow(): Record<string, unknown> {
  return {
    id: 501,
    title: "Another admin's private page",
    icon: null,
    coverImage: null,
    spaceId: null,
    projectId: null,
    parentPageId: null,
    status: "published",
    visibility: "private",
    contentType: "note",
    trustState: "unverified",
    ownerMembershipId: OTHER_ADMIN_MEMBERSHIP,
    ownerUserId: "user-other-admin",
    createdById: "user-other-admin",
    createdByMembershipId: OTHER_ADMIN_MEMBERSHIP,
    lastEditedById: "user-other-admin",
    lastEditedByMembershipId: OTHER_ADMIN_MEMBERSHIP,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-20T00:00:00Z"),
    deletedAt: null,
    nextReviewAt: null,
    verifiedUntil: null,
    contentRevision: 1,
    aclRevision: 1,
    cursorValue: "2026-09-20T00:00:00.000000",
  };
}

function makeHarness(actor: KbActorStanding) {
  const capture: Capture = { wheres: [], selectCalls: 0 };
  const rows = [foreignPrivatePageRow()];

  const db = {
    select: jest.fn(() => {
      capture.selectCalls += 1;
      const node: Record<string, unknown> = {};
      node.from = jest.fn(() => node);
      node.where = jest.fn((clause: SQL) => {
        capture.wheres.push(clause);
        return Object.assign(Promise.resolve([]), makeChain(rows, capture));
      });
      return node;
    }),
  };

  const auth = {
    resolveStanding: jest.fn().mockResolvedValue(actor),
   invalidateSpaceScope: jest.fn().mockResolvedValue(undefined), assertSpaceAccess: jest.fn().mockResolvedValue(undefined), resolveAccessibleSpaces: jest.fn().mockResolvedValue({ spaceIds: [], outcome: "hit" }) } as unknown as KnowledgeAuthorizationService;

  return {
    capture,
    svc: new KnowledgeCollectionService(db as never, auth),
  };
}

function render(clause: SQL) {
  return new PgDialect().sqlToQuery(clause);
}

describe("KnowledgeCollectionService — owner=me under administrative standing", () => {
  it.each([
    ["an org owner", standing({ isOrgOwner: true })],
    ["a knowledge admin", standing({ isKbAdmin: true })],
  ])(
    "still binds owner_membership_id to the caller for %s, so a private page owned by another authorized admin cannot be returned",
    async (_label, actor) => {
      const h = makeHarness(actor);

      await h.svc.listPages(user(), query({ owner: "me" }));

      const params = h.capture.wheres.flatMap((w) => render(w).params);
      expect(params).toContain(MY_MEMBERSHIP);
      expect(params).not.toContain(OTHER_ADMIN_MEMBERSHIP);

      const rendered = h.capture.wheres.map((w) => render(w).sql).join("\n");
      expect(rendered).toContain("owner_membership_id");
    },
  );

  it("applies the owner predicate in addition to the visible scope for an admin, never instead of it", async () => {
    const admin = makeHarness(standing({ isKbAdmin: true }));
    await admin.svc.listPages(user(), query({ owner: "me" }));
    const adminSql = admin.capture.wheres.map((w) => render(w).sql).join("\n");

    const adminNoOwner = makeHarness(standing({ isKbAdmin: true }));
    await adminNoOwner.svc.listPages(user(), query());
    const adminNoOwnerSql = adminNoOwner.capture.wheres
      .map((w) => render(w).sql)
      .join("\n");

    expect(adminNoOwnerSql).not.toContain("owner_membership_id");
    expect(adminSql).toContain("owner_membership_id");
    expect(adminSql).toContain("org_id");
  });

  it("keeps the owner predicate for an ordinary member too, so the admin case is not a render artifact", async () => {
    const h = makeHarness(standing());

    await h.svc.listPages(user(), query({ owner: "me" }));

    const params = h.capture.wheres.flatMap((w) => render(w).params);
    expect(params).toContain(MY_MEMBERSHIP);
    expect(params).not.toContain(OTHER_ADMIN_MEMBERSHIP);
  });
});
