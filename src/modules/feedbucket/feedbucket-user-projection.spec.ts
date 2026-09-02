import { FeedbucketSubmissionsService } from "./feedbucket-submissions.service";

const USER_BEARING_RELATIONS = ["assignee", "creator", "user", "approver", "author", "member"];

describe("FeedbucketSubmissionsService user projection", () => {
  it("requests no unprojected relation to global users", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: { feedbucketSubmissions: { findMany } },
      select: () => ({
        from: () => ({ where: () => Promise.resolve([{ total: 0 }]) }),
      }),
    };
    const service = new FeedbucketSubmissionsService(db as never);

    await service.list("org-1", "user-1", { page: 1, limit: 25 }, "all", null);

    const withClause = findMany.mock.calls[0]?.[0]?.with ?? {};
    const offenders = Object.entries(withClause)
      .filter(([name]) => USER_BEARING_RELATIONS.includes(name))
      .filter(([, value]) => value === true || !(value as { columns?: unknown })?.columns)
      .map(([name]) => name);

    expect(offenders).toEqual([]);
  });

  it("BITE PROOF: the same check fails when a user relation is requested unprojected", () => {
    const withClause: Record<string, unknown> = { widget: true, assignee: true };
    const offenders = Object.entries(withClause)
      .filter(([name]) => USER_BEARING_RELATIONS.includes(name))
      .filter(([, value]) => value === true || !(value as { columns?: unknown })?.columns)
      .map(([name]) => name);

    expect(offenders).toEqual(["assignee"]);
  });
});
