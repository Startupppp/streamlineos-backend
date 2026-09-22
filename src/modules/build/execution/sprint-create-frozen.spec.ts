import { GoneException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { SprintsService } from "./sprints.service";

const ORG = "org-1";
const PROJECT_ID = 42;
const VALID_INPUT = { name: "Sprint Q4", startDate: "2026-10-01", endDate: "2026-10-14" };

describe("SprintsService.createSprint — legacy-writer freeze", () => {
  it("createSprint throws GoneException — sprint creation is frozen so all new iterations use Cycles", async () => {
    const db = {} as Db;
    const svc = new SprintsService(db, null);

    await expect(svc.createSprint(ORG, PROJECT_ID, VALID_INPUT)).rejects.toThrow(GoneException);
  });

  it("createSprint makes no insert call when frozen — the write path is not reached and the DB is not mutated", async () => {
    const returning = jest.fn().mockResolvedValue([]);
    const values = jest.fn().mockReturnValue({ returning });
    const insert = jest.fn().mockReturnValue({ values });
    const projectFindFirst = jest.fn().mockResolvedValue({ id: PROJECT_ID });
    const db = {
      query: { projects: { findFirst: projectFindFirst } },
      insert,
    } as unknown as Db;
    const svc = new SprintsService(db, null);

    await expect(svc.createSprint(ORG, PROJECT_ID, VALID_INPUT)).rejects.toThrow(GoneException);

    expect(insert).not.toHaveBeenCalled();
  });

  it("createSprint throws regardless of the orgId — there is no org that can bypass the freeze", async () => {
    const db = {} as Db;
    const svc = new SprintsService(db, null);

    await expect(svc.createSprint("org-admin", PROJECT_ID, VALID_INPUT)).rejects.toThrow(GoneException);
    await expect(svc.createSprint("org-attacker", PROJECT_ID, VALID_INPUT)).rejects.toThrow(GoneException);
  });

  it("listSprints is not affected — satellite reads still work so scope events and meetings are not broken", async () => {
    const projectFindFirst = jest.fn().mockResolvedValue({ id: PROJECT_ID });
    const fakeSprint = { id: 7, orgId: ORG, projectId: PROJECT_ID, name: "old-sprint", status: "COMPLETED", deletedAt: null };
    let selectCall = 0;
    const db = {
      query: { projects: { findFirst: projectFindFirst } },
      select: jest.fn().mockImplementation(() => {
        selectCall++;
        if (selectCall === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([fakeSprint]) }),
              }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        };
      }),
    } as unknown as Db;
    const svc = new SprintsService(db, null);

    const result = await svc.listSprints(ORG, PROJECT_ID);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 7, name: "old-sprint" });
  });

  it("getSprint is not affected — deep links carrying a sprint id still resolve", async () => {
    const fakeSprint = {
      id: 7,
      orgId: ORG,
      projectId: PROJECT_ID,
      name: "old-sprint",
      status: "COMPLETED",
      goal: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      tickets: [],
    };
    const db = {
      query: {
        sprints: {
          findFirst: jest.fn().mockResolvedValue(fakeSprint),
        },
      },
    } as unknown as Db;
    const svc = new SprintsService(db, null);

    const result = await svc.getSprint(ORG, PROJECT_ID, 7);
    expect(result).toMatchObject({ id: 7, name: "old-sprint" });
  });
});
