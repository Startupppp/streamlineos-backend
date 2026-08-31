import { ForbiddenException, NotFoundException } from "@nestjs/common";
import {
  OrganizationActorError,
  assertOrganizationActor,
  legacyUserIdOf,
  organizationActorHttpError,
  organizationActorRefKey,
  resolveOrganizationActor,
  resolveOrganizationActorsByUserIds,
  type OrganizationActorRef,
} from "./organization-actor";

const ORG_A = "org_a";
const ORG_B = "org_b";
const SHARED_USER = "user_shared";

interface MembershipSeed {
  id: number;
  orgId: string;
  userId: string;
  role: string;
  isOwner: boolean;
  status: string;
}

interface PersonSeed {
  organizationPersonId: string;
  organizationId: string;
  organizationMembershipId: number | null;
  userId: string | null;
  deletedAt: Date | null;
}

describe("organizationActorRefKey", () => {
  it("produces a stable, distinct key per ref kind", () => {
    const refs: OrganizationActorRef[] = [
      { kind: "user", userId: "u1" },
      { kind: "membership", membershipId: 1 },
      { kind: "person", organizationPersonId: "p1" },
    ];
    const keys = refs.map(organizationActorRefKey);
    expect(keys).toEqual(["user:u1", "membership:1", "person:p1"]);
    expect(new Set(keys).size).toBe(3);
  });

  it("never collides a membership id with a user id of the same text", () => {
    expect(organizationActorRefKey({ kind: "membership", membershipId: 7 })).not.toBe(
      organizationActorRefKey({ kind: "user", userId: "7" }),
    );
  });
});

describe("OrganizationActorError", () => {
  it("carries organization, ref and reason for audit", () => {
    const error = new OrganizationActorError(
      ORG_A,
      { kind: "user", userId: SHARED_USER },
      "membership-inactive",
    );
    expect(error.toAuditMetadata()).toEqual({
      code: "ORGANIZATION_ACTOR_UNRESOLVED",
      orgId: ORG_A,
      ref: `user:${SHARED_USER}`,
      reason: "membership-inactive",
    });
    expect(error.message).toContain(ORG_A);
    expect(error.message).toContain("membership-inactive");
  });

  it("maps an inactive membership to 403 and every other failure to 404", () => {
    const inactive = organizationActorHttpError(
      new OrganizationActorError(ORG_A, { kind: "membership", membershipId: 1 }, "membership-inactive"),
    );
    expect(inactive).toBeInstanceOf(ForbiddenException);

    for (const reason of [
      "no-membership",
      "membership-in-another-organization",
      "ambiguous-membership",
    ] as const) {
      const mapped = organizationActorHttpError(
        new OrganizationActorError(ORG_A, { kind: "membership", membershipId: 1 }, reason),
      );
      expect(mapped).toBeInstanceOf(NotFoundException);
    }
  });

  it("never reveals that a record exists in another organization", () => {
    const mapped = organizationActorHttpError(
      new OrganizationActorError(
        ORG_A,
        { kind: "membership", membershipId: 99 },
        "membership-in-another-organization",
      ),
    );
    expect(mapped).toBeInstanceOf(NotFoundException);
    expect(JSON.stringify(mapped.getResponse())).not.toContain(ORG_B);
    expect(JSON.stringify(mapped.getResponse())).not.toContain("99");
  });
});

describe("legacyUserIdOf", () => {
  it("keeps a user-keyed caller working against a membership-keyed actor", () => {
    expect(
      legacyUserIdOf({
        orgId: ORG_A,
        membershipId: 1,
        userId: SHARED_USER,
        organizationPersonId: null,
        role: "MEMBER",
        isOwner: false,
        resolvedVia: "user",
      }),
    ).toBe(SHARED_USER);
  });
});

describe("resolution against a scripted database", () => {
  const memberships: MembershipSeed[] = [
    { id: 11, orgId: ORG_A, userId: SHARED_USER, role: "ORG_ADMIN", isOwner: false, status: "ACTIVE" },
    { id: 22, orgId: ORG_B, userId: SHARED_USER, role: "MEMBER", isOwner: true, status: "ACTIVE" },
    { id: 33, orgId: ORG_A, userId: "user_left", role: "MEMBER", isOwner: false, status: "LEFT" },
  ];
  const people: PersonSeed[] = [
    { organizationPersonId: "p_a", organizationId: ORG_A, organizationMembershipId: 11, userId: SHARED_USER, deletedAt: null },
    { organizationPersonId: "p_b", organizationId: ORG_B, organizationMembershipId: 22, userId: SHARED_USER, deletedAt: null },
    { organizationPersonId: "p_unlinked", organizationId: ORG_A, organizationMembershipId: null, userId: SHARED_USER, deletedAt: null },
  ];

  function projectedColumnNames(columns: Record<string, unknown>): string[] {
    return Object.values(columns).map((column) => {
      const named: { name?: unknown } = column as { name?: unknown };
      return typeof named.name === "string" ? named.name : "";
    });
  }

  function db(orgId: string, ref: OrganizationActorRef) {
    return {
      select: (columns: Record<string, unknown>) => {
        const names = projectedColumnNames(columns);
        const isPeopleQuery = names.includes("organization_person_id");
        const isExistenceProbe =
          !isPeopleQuery && names.length === 1 && names[0] === "id";
        return {
          from: () => ({
            where: () => ({
              limit: () => {
                if (isPeopleQuery && ref.kind === "person") {
                  const match = people.find(
                    (p) =>
                      p.organizationId === orgId &&
                      p.deletedAt === null &&
                      p.organizationPersonId === ref.organizationPersonId,
                  );
                  return Promise.resolve(match ? [match] : []);
                }
                if (isPeopleQuery) return Promise.resolve([]);

                if (isExistenceProbe) {
                  const membershipId =
                    ref.kind === "membership" ? ref.membershipId : null;
                  const match = memberships.find((m) => m.id === membershipId);
                  return Promise.resolve(match ? [{ id: match.id }] : []);
                }

                const match = memberships.find((m) =>
                  ref.kind === "user"
                    ? m.orgId === orgId && m.userId === ref.userId
                    : ref.kind === "membership"
                      ? m.id === ref.membershipId && m.orgId === orgId
                      : false,
                );
                return Promise.resolve(match ? [match] : []);
              },
            }),
          }),
        };
      },
    };
  }

  it("resolves the same global user to a DIFFERENT actor in each organization", async () => {
    const refA: OrganizationActorRef = { kind: "user", userId: SHARED_USER };
    const inA = await resolveOrganizationActor(db(ORG_A, refA) as never, ORG_A, refA);
    const inB = await resolveOrganizationActor(db(ORG_B, refA) as never, ORG_B, refA);

    expect(inA.status).toBe("resolved");
    expect(inB.status).toBe("resolved");
    if (inA.status !== "resolved" || inB.status !== "resolved") return;

    expect(inA.actor.membershipId).toBe(11);
    expect(inB.actor.membershipId).toBe(22);
    expect(inA.actor.membershipId).not.toBe(inB.actor.membershipId);
    expect(inA.actor.userId).toBe(inB.actor.userId);
    expect(inA.actor.role).toBe("ORG_ADMIN");
    expect(inB.actor.role).toBe("MEMBER");
    expect(inA.actor.isOwner).toBe(false);
    expect(inB.actor.isOwner).toBe(true);
  });

  it("fails closed for a user with no membership in the organization", async () => {
    const ref: OrganizationActorRef = { kind: "user", userId: "nobody" };
    const result = await resolveOrganizationActor(db(ORG_A, ref) as never, ORG_A, ref);
    expect(result).toMatchObject({ status: "unresolved", reason: "no-membership" });
  });

  it("fails closed for an inactive membership instead of returning the actor", async () => {
    const ref: OrganizationActorRef = { kind: "user", userId: "user_left" };
    const result = await resolveOrganizationActor(db(ORG_A, ref) as never, ORG_A, ref);
    expect(result).toMatchObject({ status: "unresolved", reason: "membership-inactive" });
  });

  it("fails closed when a membership id belongs to another organization", async () => {
    const ref: OrganizationActorRef = { kind: "membership", membershipId: 22 };
    const result = await resolveOrganizationActor(db(ORG_A, ref) as never, ORG_A, ref);
    expect(result).toMatchObject({
      status: "unresolved",
      reason: "membership-in-another-organization",
    });
  });

  it("assertOrganizationActor throws an auditable error rather than returning null", async () => {
    const ref: OrganizationActorRef = { kind: "user", userId: "nobody" };
    await expect(
      assertOrganizationActor(db(ORG_A, ref) as never, ORG_A, ref),
    ).rejects.toBeInstanceOf(OrganizationActorError);
  });

  it("assertOrganizationActor returns the actor on the happy path", async () => {
    const ref: OrganizationActorRef = { kind: "user", userId: SHARED_USER };
    const actor = await assertOrganizationActor(db(ORG_A, ref) as never, ORG_A, ref);
    expect(actor.membershipId).toBe(11);
    expect(actor.resolvedVia).toBe("user");
  });
});

describe("resolveOrganizationActorsByUserIds", () => {
  it("returns an empty map without querying when given no ids", async () => {
    let queried = false;
    const db = {
      select: () => {
        queried = true;
        return { from: () => ({ where: () => Promise.resolve([]) }) };
      },
    };
    const result = await resolveOrganizationActorsByUserIds(db as never, ORG_A, []);
    expect(result.size).toBe(0);
    expect(queried).toBe(false);
  });

  it("resolves a batch in two queries, not one per user", async () => {
    let selectCalls = 0;
    const memberships = [
      { id: 11, orgId: ORG_A, userId: "u1", role: "MEMBER", isOwner: false, status: "ACTIVE" },
      { id: 12, orgId: ORG_A, userId: "u2", role: "MEMBER", isOwner: false, status: "ACTIVE" },
      { id: 13, orgId: ORG_A, userId: "u3", role: "MEMBER", isOwner: false, status: "ACTIVE" },
    ];
    const people = [{ membershipId: 12, organizationPersonId: "p12" }];
    const db = {
      select: (columns: Record<string, unknown>) => {
        selectCalls += 1;
        const isPeople = "membershipId" in columns;
        return {
          from: () => ({
            where: () => Promise.resolve(isPeople ? people : memberships),
          }),
        };
      },
    };
    const result = await resolveOrganizationActorsByUserIds(db as never, ORG_A, [
      "u1",
      "u2",
      "u3",
      "u1",
    ]);
    expect(selectCalls).toBe(2);
    expect(result.size).toBe(3);
    expect(result.get("u2")?.organizationPersonId).toBe("p12");
    expect(result.get("u1")?.organizationPersonId).toBeNull();
    expect(result.get("u3")?.membershipId).toBe(13);
  });
});
