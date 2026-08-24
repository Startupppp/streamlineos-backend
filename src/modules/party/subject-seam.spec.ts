import type { Db } from "../../db/drizzle.types";
import { isSubjectResolved, resolveSubject, type SubjectSubject } from "./subject-seam";

interface Recorded {
  wheres: unknown[];
  joins: unknown[];
}

function dbReturning(rows: Record<string, unknown>[], recorded: Recorded): Db {
  const chain = {
    from: () => chain,
    innerJoin: (_table: unknown, on: unknown) => {
      recorded.joins.push(on);
      return chain;
    },
    where: (predicate: unknown) => {
      recorded.wheres.push(predicate);
      return chain;
    },
    limit: async () => rows,
  };
  return { select: () => chain } as unknown as Db;
}

const property = {
  subjectId: "s-1",
  organizationId: "org-1",
  subjectTypeId: "t-1",
  typeKey: "property",
  title: "12 Harbour Lane",
  status: "listed",
  customFields: { bedrooms: 3 },
  fields: [{ name: "bedrooms", label: "Bedrooms", kind: "number" }],
};

describe("resolveSubject", () => {
  let recorded: Recorded;

  beforeEach(() => {
    recorded = { wheres: [], joins: [] };
  });

  it("resolves a subject together with its type declaration", async () => {
    const result = await resolveSubject(dbReturning([property], recorded), "org-1", {
      kind: "subject",
      subjectId: "s-1",
    });

    expect(isSubjectResolved(result)).toBe(true);
    if (!isSubjectResolved(result)) return;
    expect(result.subject).toMatchObject({ title: "12 Harbour Lane", typeKey: "property" });
    expect(result.subject.fields).toHaveLength(1);
  });

  it("says which lookup answered, because resolution short-circuits", async () => {
    const bySubject = await resolveSubject(dbReturning([property], recorded), "org-1", {
      kind: "subject",
      subjectId: "s-1",
    });
    const byLink = await resolveSubject(
      dbReturning([{ ...property, linkedPartyId: "p-1" }], recorded),
      "org-1",
      { kind: "link", subjectPartyLinkId: "l-1" },
    );

    expect(isSubjectResolved(bySubject) && bySubject.subject.resolvedVia).toBe("subject-record");
    expect(isSubjectResolved(byLink) && byLink.subject.resolvedVia).toBe("link-record");
  });

  it("reaches a subject through a link, carrying the party that linked it", async () => {
    const result = await resolveSubject(
      dbReturning([{ ...property, linkedPartyId: "p-1" }], recorded),
      "org-1",
      { kind: "link", subjectPartyLinkId: "l-1" },
    );

    expect(isSubjectResolved(result) && result.subject.linkedPartyId).toBe("p-1");
  });

  it("returns unresolved as a value rather than throwing", async () => {
    const subject: SubjectSubject = { kind: "subject", subjectId: "missing" };
    const result = await resolveSubject(dbReturning([], recorded), "org-1", subject);

    expect(result).toEqual({ status: "unresolved", subject });
  });

  it("hands back the subject it failed on, so a caller can say what was not found", async () => {
    const subject: SubjectSubject = { kind: "link", subjectPartyLinkId: "l-9" };
    const result = await resolveSubject(dbReturning([], recorded), "org-1", subject);

    expect(result.status).toBe("unresolved");
    if (result.status !== "unresolved") return;
    expect(result.subject).toBe(subject);
  });

  it("re-asserts the organisation rather than trusting row-level security", async () => {
    await resolveSubject(dbReturning([property], recorded), "org-1", {
      kind: "subject",
      subjectId: "s-1",
    });

    expect(recorded.wheres).toHaveLength(1);
    expect(recorded.wheres[0]).toBeDefined();
  });

  it("carries the tenant through the type join, so a tampered type id cannot cross", async () => {
    await resolveSubject(dbReturning([property], recorded), "org-1", {
      kind: "subject",
      subjectId: "s-1",
    });

    expect(recorded.joins).toHaveLength(1);
  });

  it("joins through both tenant-scoped hops when resolving from a link", async () => {
    await resolveSubject(dbReturning([], recorded), "org-1", {
      kind: "link",
      subjectPartyLinkId: "l-1",
    });

    expect(recorded.joins).toHaveLength(2);
  });

  it("refuses to resolve without an organisation, instead of reading unscoped", async () => {
    const scopeless: Recorded = { wheres: [], joins: [] };
    const result = await resolveSubject(dbReturning([property], scopeless), "", {
      kind: "subject",
      subjectId: "s-1",
    });

    expect(result.status).toBe("unresolved");
    expect(scopeless.wheres).toHaveLength(0);
  });

  it("refuses an empty identifier without querying", async () => {
    const bySubject: Recorded = { wheres: [], joins: [] };
    const byLink: Recorded = { wheres: [], joins: [] };

    await resolveSubject(dbReturning([property], bySubject), "org-1", {
      kind: "subject",
      subjectId: "",
    });
    await resolveSubject(dbReturning([property], byLink), "org-1", {
      kind: "link",
      subjectPartyLinkId: "",
    });

    expect(bySubject.wheres).toHaveLength(0);
    expect(byLink.wheres).toHaveLength(0);
  });

  it("narrows the union, so a resolved branch exposes the subject without a cast", async () => {
    const result = await resolveSubject(dbReturning([property], recorded), "org-1", {
      kind: "subject",
      subjectId: "s-1",
    });

    if (isSubjectResolved(result)) expect(result.subject.organizationId).toBe("org-1");
    else throw new Error("expected resolved");
  });
});
