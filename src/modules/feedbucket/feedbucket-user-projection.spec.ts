import { FeedbucketSubmissionsService } from "./feedbucket-submissions.service";

describe("FeedbucketSubmissionsService user projection", () => {
  it("projects assignee identity without global-user secrets", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: { feedbucketSubmissions: { findMany } },
      select: () => ({
        from: () => ({ where: () => Promise.resolve([{ total: 0 }]) }),
      }),
    };
    const service = new FeedbucketSubmissionsService(db as never);

    await service.list(
      "org-1",
      "user-1",
      { page: 1, limit: 25 },
      "all",
      null,
    );

    const call = findMany.mock.calls[0]?.[0];
    expect(call?.with?.assignee).toBeUndefined();
    expect(call?.columns?.consoleLogs).toBe(false);
    expect(call?.columns?.networkLogs).toBe(false);
  });
});
