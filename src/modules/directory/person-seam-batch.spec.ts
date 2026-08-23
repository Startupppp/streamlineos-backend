import {
  resolvePeopleIdentities,
  subjectKey,
  type PersonSubject,
} from "./person-seam";
import type { Db } from "../../db/drizzle.module";

type Row = Record<string, unknown>;

function createDb(rows: Row[]) {
  const select = jest.fn(() => {
    const link: Record<string, unknown> = {};
    for (const method of ["from", "leftJoin"]) link[method] = () => link;
    link["where"] = () => Promise.resolve(rows);
    return link;
  });
  return { db: { select } as unknown as Db, select };
}

const ORG = "org-1";

const PERSON_ROW: Row = {
  organizationPersonId: "person-1",
  userId: "user-1",
  workerId: "worker-1",
  displayName: "Asha Menon",
  firstName: "Asha",
  lastName: "Menon",
  workEmail: "asha@example.com",
  membershipId: 7,
  isPayee: true,
};

describe("resolving many people at once", () => {
  it("issues one query however many subjects it is given", async () => {
    const { db, select } = createDb([PERSON_ROW]);
    const subjects: PersonSubject[] = Array.from({ length: 50 }, (_, i) => ({
      kind: "user",
      userId: `user-${i}`,
    }));

    await resolvePeopleIdentities(db, ORG, subjects);

    expect(select).toHaveBeenCalledTimes(1);
  });

  it("issues no query at all for an empty subject list", async () => {
    const { db, select } = createDb([]);
    const identities = await resolvePeopleIdentities(db, ORG, []);

    expect(select).not.toHaveBeenCalled();
    expect(identities.size).toBe(0);
  });

  it("keys the answer by whichever subject form the caller holds", async () => {
    const { db } = createDb([PERSON_ROW]);
    const identities = await resolvePeopleIdentities(db, ORG, [
      { kind: "user", userId: "user-1" },
      { kind: "worker", workerId: "worker-1" },
      { kind: "person", organizationPersonId: "person-1" },
    ]);

    expect(identities.get(subjectKey({ kind: "user", userId: "user-1" })))
      .toMatchObject({ displayName: "Asha Menon" });
    expect(identities.get(subjectKey({ kind: "worker", workerId: "worker-1" })))
      .toMatchObject({ displayName: "Asha Menon" });
    expect(
      identities.get(
        subjectKey({ kind: "person", organizationPersonId: "person-1" }),
      ),
    ).toMatchObject({ displayName: "Asha Menon" });
  });

  it("leaves a subject that does not resolve out of the answer", async () => {
    const { db } = createDb([PERSON_ROW]);
    const identities = await resolvePeopleIdentities(db, ORG, [
      { kind: "user", userId: "user-1" },
      { kind: "user", userId: "nobody" },
    ]);

    expect(identities.has(subjectKey({ kind: "user", userId: "user-1" }))).toBe(
      true,
    );
    expect(identities.has(subjectKey({ kind: "user", userId: "nobody" }))).toBe(
      false,
    );
  });

  it("reports membership and payee standing as flags", async () => {
    const { db } = createDb([PERSON_ROW]);
    const identities = await resolvePeopleIdentities(db, ORG, [
      { kind: "user", userId: "user-1" },
    ]);
    const identity = identities.get(
      subjectKey({ kind: "user", userId: "user-1" }),
    );

    expect(identity?.isMember).toBe(true);
    expect(identity?.isPayeeWorker).toBe(true);
  });

  it("returns identity only, never anything a permission gate owns", async () => {
    const { db } = createDb([{ ...PERSON_ROW, bankDetails: "should-not-leak" }]);
    const identities = await resolvePeopleIdentities(db, ORG, [
      { kind: "user", userId: "user-1" },
    ]);
    const identity = identities.get(
      subjectKey({ kind: "user", userId: "user-1" }),
    );

    expect(identity).toBeDefined();
    expect(Object.keys(identity ?? {})).not.toContain("bankDetails");
  });
});
