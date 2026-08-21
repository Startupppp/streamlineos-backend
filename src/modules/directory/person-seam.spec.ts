import { resolvePerson, type PersonResolution } from "./person-seam";
import type { Db } from "../../db/drizzle.module";

type Row = Record<string, unknown>;

function createDb(options: { membership?: Row | null; results?: Row[][] }) {
  const results = options.results ?? [];
  let cursor = 0;
  const chain = () => {
    const link: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "leftJoin", "where"])
      link[method] = () => link;
    link["limit"] = () => Promise.resolve(results[cursor++] ?? []);
    return link;
  };
  return {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(options.membership ?? null),
      },
    },
    select: jest.fn(() => chain()),
  } as unknown as Db;
}

function expectResolved(resolution: PersonResolution) {
  if (resolution.status !== "resolved")
    throw new Error(`expected resolved, got ${resolution.status}`);
  return resolution.person;
}

const ORG = "org-1";

describe("resolvePerson", () => {
  it("resolves a platform member as payable", async () => {
    const db = createDb({ membership: { id: 7 } });
    const person = expectResolved(
      await resolvePerson(db, ORG, { kind: "user", userId: "user-1" }),
    );
    expect(person.isMember).toBe(true);
    expect(person.payable).toBe(true);
  });

  it("resolves a non-member payee worker as payable", async () => {
    const db = createDb({
      results: [[{ workerId: "w-1", organizationPersonId: "p-1", userId: "user-1" }]],
    });
    const person = expectResolved(
      await resolvePerson(db, ORG, { kind: "user", userId: "user-1" }),
    );
    expect(person.isMember).toBe(false);
    expect(person.isPayeeWorker).toBe(true);
    expect(person.workerId).toBe("w-1");
    expect(person.payable).toBe(true);
  });

  it("resolves a worker with no login, carrying a null user", async () => {
    const db = createDb({
      results: [[{ workerId: "w-2", organizationPersonId: "p-2", userId: null }]],
    });
    const person = expectResolved(
      await resolvePerson(db, ORG, { kind: "worker", workerId: "w-2" }),
    );
    expect(person.userId).toBeNull();
    expect(person.payable).toBe(true);
  });

  it("resolves a person recorded without a login, with their employment", async () => {
    const db = createDb({
      results: [
        [{ organizationPersonId: "p-3", userId: null, membershipId: null }],
        [],
        [{ employmentId: 11, employeeNumber: "E-11", lifecycleStatus: "ACTIVE" }],
      ],
    });
    const person = expectResolved(
      await resolvePerson(db, ORG, {
        kind: "person",
        organizationPersonId: "p-3",
      }),
    );
    expect(person.userId).toBeNull();
    expect(person.employment).toEqual({
      employmentId: 11,
      employeeNumber: "E-11",
      lifecycleStatus: "ACTIVE",
    });
  });

  it("holds employment and payability apart — an employed person is not payable until made a payee", async () => {
    const db = createDb({
      results: [
        [{ organizationPersonId: "p-4", userId: null, membershipId: null }],
        [{ workerId: "w-4", isPayee: false }],
        [{ employmentId: 12, employeeNumber: "E-12", lifecycleStatus: "ACTIVE" }],
      ],
    });
    const person = expectResolved(
      await resolvePerson(db, ORG, {
        kind: "person",
        organizationPersonId: "p-4",
      }),
    );
    expect(person.employment).not.toBeNull();
    expect(person.payable).toBe(false);
  });

  it("reports which path resolved it, so a caller can tell a short-circuit from a full lookup", async () => {
    const viaMembership = expectResolved(
      await resolvePerson(createDb({ membership: { id: 7 } }), ORG, {
        kind: "user",
        userId: "user-1",
      }),
    );
    expect(viaMembership.resolvedVia).toBe("membership");
    expect(viaMembership.workerId).toBeNull();

    const viaWorker = expectResolved(
      await resolvePerson(
        createDb({ results: [[{ workerId: "w-1", organizationPersonId: "p-1", userId: "u" }]] }),
        ORG,
        { kind: "worker", workerId: "w-1" },
      ),
    );
    expect(viaWorker.resolvedVia).toBe("payee-worker");

    const viaRecord = expectResolved(
      await resolvePerson(
        createDb({
          results: [[{ organizationPersonId: "p-9", userId: null, membershipId: null }], [], []],
        }),
        ORG,
        { kind: "person", organizationPersonId: "p-9" },
      ),
    );
    expect(viaRecord.resolvedVia).toBe("person-record");
  });

  it("names the identity a member is payable as", async () => {
    const person = expectResolved(
      await resolvePerson(createDb({ membership: { id: 7 } }), ORG, {
        kind: "user",
        userId: "user-1",
      }),
    );
    expect(person.payableAs).toEqual({ kind: "user", userId: "user-1" });
  });

  it("names the identity a login-less payee is payable as", async () => {
    const person = expectResolved(
      await resolvePerson(
        createDb({ results: [[{ workerId: "w-2", organizationPersonId: "p-2", userId: null }]] }),
        ORG,
        { kind: "worker", workerId: "w-2" },
      ),
    );
    expect(person.payableAs).toEqual({ kind: "worker", workerId: "w-2" });
  });

  it("pays a person who is both a member and a payee worker through their membership, matching the user path", async () => {
    const person = expectResolved(
      await resolvePerson(
        createDb({
          results: [
            [{ organizationPersonId: "p-5", userId: "user-5", membershipId: 3 }],
            [{ workerId: "w-5", isPayee: true }],
            [],
          ],
        }),
        ORG,
        { kind: "person", organizationPersonId: "p-5" },
      ),
    );
    expect(person.payableAs).toEqual({ kind: "user", userId: "user-5" });
  });

  it("pays a login-less person through their payee worker record", async () => {
    const person = expectResolved(
      await resolvePerson(
        createDb({
          results: [
            [{ organizationPersonId: "p-6", userId: null, membershipId: null }],
            [{ workerId: "w-6", isPayee: true }],
            [],
          ],
        }),
        ORG,
        { kind: "person", organizationPersonId: "p-6" },
      ),
    );
    expect(person.payableAs).toEqual({ kind: "worker", workerId: "w-6" });
    expect(person.payable).toBe(true);
  });

  it("refuses to call a person payable with no identity to pay them by", async () => {
    const person = expectResolved(
      await resolvePerson(
        createDb({
          results: [
            [{ organizationPersonId: "p-7", userId: null, membershipId: 4 }],
            [{ workerId: "w-7", isPayee: false }],
            [],
          ],
        }),
        ORG,
        { kind: "person", organizationPersonId: "p-7" },
      ),
    );
    expect(person.payableAs).toBeNull();
    expect(person.payable).toBe(false);
  });

  it.each([
    ["user", { kind: "user" as const, userId: "nobody" }],
    ["worker", { kind: "worker" as const, workerId: "nobody" }],
    ["person", { kind: "person" as const, organizationPersonId: "nobody" }],
  ])("returns an unresolved value rather than throwing for an unknown %s", async (_label, subject) => {
    const resolution = await resolvePerson(createDb({}), ORG, subject);
    expect(resolution.status).toBe("unresolved");
    if (resolution.status === "unresolved") expect(resolution.subject).toEqual(subject);
  });
});
