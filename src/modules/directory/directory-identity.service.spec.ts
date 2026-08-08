import { DirectoryIdentityService } from "./directory-identity.service";

const ORG_ID = "org-1";
const PERSON_ID = "person-1";
const MEMBER_USER_ID = "user-1";

function makePerson(overrides: Record<string, unknown> = {}) {
  return {
    organizationPersonId: PERSON_ID,
    organizationId: ORG_ID,
    userId: null,
    organizationMembershipId: null,
    firstName: "Jane",
    lastName: "Doe",
    displayName: null,
    preferredName: null,
    workEmail: "jane@example.com",
    personalEmail: null,
    phone: null,
    whatsappNumber: null,
    avatarUrl: null,
    dateOfBirth: null,
    gender: null,
    nationality: null,
    timezone: null,
    languageCode: "en",
    address: null,
    emergencyContact: null,
    linkedinUrl: null,
    githubUrl: null,
    bio: null,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function limitedSelect(rows: unknown[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ limit });
  const innerJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ innerJoin, where });
  return { chain: { from }, where, limit };
}

function memberListSelect(rows: unknown[]) {
  const where = jest.fn().mockResolvedValue(rows);
  const innerJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ innerJoin });
  return { chain: { from }, where };
}

function invitationListSelect(rows: unknown[]) {
  const orderBy = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  return { chain: { from }, where };
}

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => sqlValues(item, seen));
  }
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

describe("DirectoryIdentityService", () => {
  it("reconciles an existing person with an active member by normalized work email", async () => {
    const member = {
      membershipId: 42,
      userId: MEMBER_USER_ID,
      email: "jane@example.com",
      name: "Jane Doe",
      firstName: "Jane",
      lastName: "Doe",
      phone: null,
    };
    const memberQuery = limitedSelect([member]);
    const linked = makePerson({
      workEmail: " JANE@EXAMPLE.COM ",
      userId: MEMBER_USER_ID,
      organizationMembershipId: 42,
    });
    const returning = jest.fn().mockResolvedValue([linked]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const db = {
      select: jest.fn().mockReturnValue(memberQuery.chain),
      update: jest.fn().mockReturnValue({ set }),
    };
    const service = new DirectoryIdentityService(db as never);

    await expect(
      service.reconcilePersonIdentity(
        ORG_ID,
        makePerson({ workEmail: " JANE@EXAMPLE.COM " }) as never,
      ),
    ).resolves.toMatchObject({
      userId: MEMBER_USER_ID,
      organizationMembershipId: 42,
    });
    expect(set).toHaveBeenCalledWith({
      userId: MEMBER_USER_ID,
      organizationMembershipId: 42,
    });
    expect(sqlValues(memberQuery.where.mock.calls[0]?.[0])).toContain(
      "jane@example.com",
    );
  });

  it("falls back to normalized personal email when work email is absent", async () => {
    const member = {
      membershipId: 43,
      userId: MEMBER_USER_ID,
      email: "jane.personal@example.com",
      name: "Jane Doe",
      firstName: "Jane",
      lastName: "Doe",
      phone: null,
    };
    const memberQuery = limitedSelect([member]);
    const linked = makePerson({
      workEmail: null,
      personalEmail: " JANE.PERSONAL@EXAMPLE.COM ",
      userId: MEMBER_USER_ID,
      organizationMembershipId: 43,
    });
    const returning = jest.fn().mockResolvedValue([linked]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const db = {
      select: jest.fn().mockReturnValue(memberQuery.chain),
      update: jest.fn().mockReturnValue({ set }),
    };
    const service = new DirectoryIdentityService(db as never);

    await expect(
      service.reconcilePersonIdentity(
        ORG_ID,
        makePerson({
          workEmail: null,
          personalEmail: " JANE.PERSONAL@EXAMPLE.COM ",
        }) as never,
      ),
    ).resolves.toMatchObject({
      userId: MEMBER_USER_ID,
      organizationMembershipId: 43,
    });
    expect(set).toHaveBeenCalledWith({
      userId: MEMBER_USER_ID,
      organizationMembershipId: 43,
    });
    expect(sqlValues(memberQuery.where.mock.calls[0]?.[0])).toContain(
      "jane.personal@example.com",
    );
  });

  it("refreshes a stale membership id for the same linked user", async () => {
    const member = {
      membershipId: 43,
      userId: MEMBER_USER_ID,
      email: "jane@example.com",
      name: "Jane Doe",
      firstName: "Jane",
      lastName: "Doe",
      phone: null,
    };
    const memberQuery = limitedSelect([member]);
    const linked = makePerson({
      userId: MEMBER_USER_ID,
      organizationMembershipId: 43,
    });
    const returning = jest.fn().mockResolvedValue([linked]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const db = {
      select: jest.fn().mockReturnValue(memberQuery.chain),
      update: jest.fn().mockReturnValue({ set }),
    };
    const service = new DirectoryIdentityService(db as never);

    await expect(
      service.reconcilePersonIdentity(
        ORG_ID,
        makePerson({
          userId: MEMBER_USER_ID,
          organizationMembershipId: 41,
        }) as never,
      ),
    ).resolves.toMatchObject({ organizationMembershipId: 43 });
    expect(set).toHaveBeenCalledWith({
      userId: MEMBER_USER_ID,
      organizationMembershipId: 43,
    });
  });

  it("does not auto-link by personal email when a work email is present", async () => {
    const memberQuery = limitedSelect([]);
    const db = {
      select: jest.fn().mockReturnValue(memberQuery.chain),
      update: jest.fn(),
    };
    const service = new DirectoryIdentityService(db as never);
    const person = makePerson({
      workEmail: " Work@Example.com ",
      personalEmail: "matching-member@example.com",
    });

    await expect(
      service.reconcilePersonIdentity(ORG_ID, person as never),
    ).resolves.toBe(person);
    expect(db.update).not.toHaveBeenCalled();

    const identityFilterValues = sqlValues(
      memberQuery.where.mock.calls[0]?.[0],
    );
    expect(identityFilterValues).toContain("work@example.com");
    expect(identityFilterValues).not.toContain("matching-member@example.com");
  });

  it("bulk-enriches member and invitation access without per-person queries", async () => {
    const now = Date.now();
    const people = [
      makePerson({
        organizationPersonId: "person-member",
        workEmail: " MEMBER@EXAMPLE.COM ",
      }),
      makePerson({
        organizationPersonId: "person-pending",
        workEmail: null,
        personalEmail: " Pending@Example.com ",
      }),
      makePerson({
        organizationPersonId: "person-expired-by-time",
        workEmail: "expired-time@example.com",
      }),
      makePerson({
        organizationPersonId: "person-expired-by-state",
        workEmail: "expired-state@example.com",
      }),
      makePerson({
        organizationPersonId: "person-revoked",
        workEmail: "revoked@example.com",
      }),
      makePerson({
        organizationPersonId: "person-declined",
        workEmail: "declined@example.com",
      }),
    ];
    const memberQuery = memberListSelect([
      {
        membershipId: 42,
        userId: MEMBER_USER_ID,
        email: "member@example.com",
      },
    ]);
    const invitationQuery = invitationListSelect([
      {
        id: "invite-pending",
        email: "pending@example.com",
        role: "MEMBER",
        status: "PENDING",
        expiresAt: new Date(now + 60_000),
      },
      {
        id: "invite-expired-time",
        email: "expired-time@example.com",
        role: "MEMBER",
        status: "PENDING",
        expiresAt: new Date(now - 60_000),
      },
      {
        id: "invite-expired-state",
        email: "expired-state@example.com",
        role: "ADMIN",
        status: "EXPIRED",
        expiresAt: new Date(now + 60_000),
      },
    ]);
    const db = {
      select: jest
        .fn()
        .mockReturnValueOnce(memberQuery.chain)
        .mockReturnValueOnce(invitationQuery.chain),
    };
    const service = new DirectoryIdentityService(db as never);

    const result = await service.resolvePeopleAccess(ORG_ID, people as never);

    expect(result.map((person) => person.accountAccess)).toEqual([
      { state: "MEMBER" },
      expect.objectContaining({
        state: "INVITED",
        invitationId: "invite-pending",
        invitationStatus: "PENDING",
      }),
      expect.objectContaining({
        state: "INVITED",
        invitationId: "invite-expired-time",
        invitationStatus: "EXPIRED",
      }),
      expect.objectContaining({
        state: "INVITED",
        invitationId: "invite-expired-state",
        invitationStatus: "EXPIRED",
      }),
      { state: "NONE" },
      { state: "NONE" },
    ]);
    expect(db.select).toHaveBeenCalledTimes(2);

    const invitationFilterValues = sqlValues(
      invitationQuery.where.mock.calls[0]?.[0],
    );
    expect(invitationFilterValues).toEqual(
      expect.arrayContaining(["PENDING", "EXPIRED"]),
    );
    expect(invitationFilterValues).not.toEqual(
      expect.arrayContaining(["REVOKED", "DECLINED"]),
    );
  });

  it("creates and links a directory person when starting from a member", async () => {
    const member = {
      membershipId: 42,
      userId: MEMBER_USER_ID,
      email: "MEMBER@EXAMPLE.COM",
      name: "Jane Doe",
      firstName: null,
      lastName: null,
      phone: "+10000000000",
    };
    const memberQuery = limitedSelect([member]);
    const personQuery = limitedSelect([]);
    const deletedPersonQuery = limitedSelect([]);
    const created = makePerson({
      userId: MEMBER_USER_ID,
      organizationMembershipId: 42,
      workEmail: "member@example.com",
    });
    const returning = jest.fn().mockResolvedValue([created]);
    const values = jest.fn().mockReturnValue({ returning });
    const db = {
      select: jest
        .fn()
        .mockReturnValueOnce(memberQuery.chain)
        .mockReturnValueOnce(personQuery.chain)
        .mockReturnValueOnce(deletedPersonQuery.chain),
      insert: jest.fn().mockReturnValue({ values }),
    };
    const service = new DirectoryIdentityService(db as never);

    await expect(
      service.ensurePersonForMember(ORG_ID, MEMBER_USER_ID),
    ).resolves.toMatchObject({
      userId: MEMBER_USER_ID,
      organizationMembershipId: 42,
    });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        userId: MEMBER_USER_ID,
        organizationMembershipId: 42,
        firstName: "Jane",
        lastName: "Doe",
        workEmail: "member@example.com",
      }),
    );
  });

  it("restores a soft-deleted matching person instead of creating a duplicate", async () => {
    const member = {
      membershipId: 42,
      userId: MEMBER_USER_ID,
      email: "member@example.com",
      name: "Jane Doe",
      firstName: "Jane",
      lastName: "Doe",
      phone: null,
    };
    const deleted = makePerson({
      userId: MEMBER_USER_ID,
      organizationMembershipId: 42,
      workEmail: "member@example.com",
      deletedAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    const restored = { ...deleted, deletedAt: null };
    const memberQuery = limitedSelect([member]);
    const activePersonQuery = limitedSelect([]);
    const deletedPersonQuery = limitedSelect([deleted]);
    const returning = jest.fn().mockResolvedValue([restored]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const db = {
      select: jest
        .fn()
        .mockReturnValueOnce(memberQuery.chain)
        .mockReturnValueOnce(activePersonQuery.chain)
        .mockReturnValueOnce(deletedPersonQuery.chain),
      update: jest.fn().mockReturnValue({ set }),
      insert: jest.fn(),
    };
    const service = new DirectoryIdentityService(db as never);

    await expect(
      service.ensurePersonForMember(ORG_ID, MEMBER_USER_ID),
    ).resolves.toMatchObject({
      organizationPersonId: PERSON_ID,
      deletedAt: null,
      userId: MEMBER_USER_ID,
      organizationMembershipId: 42,
    });
    expect(set).toHaveBeenCalledWith({
      deletedAt: null,
      userId: MEMBER_USER_ID,
      organizationMembershipId: 42,
    });
    expect(db.insert).not.toHaveBeenCalled();
  });
});
