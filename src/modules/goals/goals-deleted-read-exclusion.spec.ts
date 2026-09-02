import { makeFakeDb } from "../../test/fake-select-db";
import type { Db } from "../../db/drizzle.types";
import { okrGoals, okrKeyResults, projects, tickets } from "../../db/schema";
import { GoalKeyResultsService } from "./goal-key-results.service";
import { GoalLinksService } from "./goal-links.service";

const ORG = "org-1";

function goal(overrides: Record<string, unknown>) {
  return { id: 1, org_id: ORG, title: "Goal", deleted_at: null, ...overrides };
}

describe("goal reads exclude soft-deleted rows", () => {
  it("createKeyResult refuses a soft-deleted goal", async () => {
    const db = makeFakeDb({ okr_goals: [goal({ id: 7, deleted_at: new Date() })], okr_key_results: [] }, { okrGoals, okrKeyResults });
    const service = new GoalKeyResultsService(db as unknown as Db);

    const created = await service.createKeyResult(ORG, 7, {
      title: "KR",
      metricType: "number",
      startValue: 0,
      targetValue: 10,
      currentValue: 0,
      status: "on_track",
    });

    expect(created).toBeNull();
  });

  it("createKeyResult still accepts a live goal", async () => {
    const db = makeFakeDb({ okr_goals: [goal({ id: 8 })], okr_key_results: [] }, { okrGoals, okrKeyResults });
    const service = new GoalKeyResultsService(db as unknown as Db);

    await expect(
      service.createKeyResult(ORG, 8, {
        title: "KR",
        metricType: "number",
        startValue: 0,
        targetValue: 10,
        currentValue: 0,
        status: "on_track",
      }),
    ).resolves.not.toBeNull();
  });

  it("createLink refuses a soft-deleted goal", async () => {
    const db = makeFakeDb({ okr_goals: [goal({ id: 9, deleted_at: new Date() })], projects: [{ id: 3, org_id: ORG, name: "Live", key: "LIV", deleted_at: null }], tickets: [] }, { okrGoals, projects, tickets });
    const service = new GoalLinksService(db as unknown as Db);

    await expect(service.createLink(ORG, 9, { projectId: 3 })).resolves.toEqual({
      error: "goal_not_found",
    });
  });

  it("getLinks does not name a soft-deleted project", async () => {
    const db = makeFakeDb({
      okr_links: [{ id: 1, org_id: ORG, goal_id: 5, ticket_id: null, project_id: 3, created_at: new Date() }],
      tickets: [],
      projects: [{ id: 3, org_id: ORG, name: "Deleted project", key: "DEL", deleted_at: new Date() }],
    });
    const service = new GoalLinksService(db as unknown as Db);

    const links = await service.getLinks(ORG, 5);

    expect(links).toHaveLength(1);
    expect(links[0]?.projectName).toBeNull();
  });
});
