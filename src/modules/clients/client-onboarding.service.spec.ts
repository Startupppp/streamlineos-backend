import type { Db } from "../../db/drizzle.module";
import { ClientOnboardingService } from "./client-onboarding.service";

function thenable<T>(value: T) {
  return {
    then: (resolve: (result: T) => unknown) => Promise.resolve(value).then(resolve),
    catch: (reject: (error: unknown) => unknown) => Promise.resolve(value).catch(reject),
    finally: (done: () => void) => Promise.resolve(value).finally(done),
  };
}

describe("ClientOnboardingService", () => {
  const actor = { userId: "user-1", membershipId: 41 };
  const audit = { log: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  it("starts the built-in default checklist when an organization has no default template", async () => {
    const inserted: unknown[] = [];
    const selectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockImplementation(() => thenable([])),
    };
    const insertChain = {
      values: jest.fn().mockImplementation((values: unknown) => {
        inserted.push(values);
        return thenable(values);
      }),
    };
    const db = {
      select: jest.fn().mockReturnValue(selectChain),
      insert: jest.fn().mockReturnValue(insertChain),
    } as unknown as Db;
    const service = new ClientOnboardingService(db, audit as never);

    await service.startForClient("org-1", 7, actor);

    expect(inserted).toEqual([
      expect.arrayContaining([
        expect.objectContaining({ orgId: "org-1", clientId: 7, title: "Confirm client details", sortOrder: 0 }),
        expect.objectContaining({ orgId: "org-1", clientId: 7, title: "Agree onboarding goals", sortOrder: 1 }),
        expect.objectContaining({ orgId: "org-1", clientId: 7, title: "Schedule kickoff", sortOrder: 2 }),
      ]),
    ]);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: "client.onboarding.started",
      actorMembershipId: 41,
      resourceId: "7",
    }));
  });

  it("archives an onboarding item instead of deleting its history", async () => {
    const returning = jest.fn().mockResolvedValue([{ id: 9 }]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const db = {
      update: jest.fn().mockReturnValue({ set }),
      delete: jest.fn(),
    } as unknown as Db;
    const service = new ClientOnboardingService(db, audit as never);

    await expect(service.archiveItem("org-1", 9, actor)).resolves.toEqual({ success: true });

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      archivedBy: "user-1",
      archivedByMembershipId: 41,
      archivedAt: expect.any(Date),
    }));
    expect((db as unknown as { delete: jest.Mock }).delete).not.toHaveBeenCalled();
  });

  it("rejects an assignee who has no active membership in the client organization", async () => {
    const chain = (rows: unknown[]) => ({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockImplementation(() => thenable(rows)),
    });
    const db = {
      select: jest.fn()
        .mockReturnValueOnce(chain([{ id: 7 }]))
        .mockReturnValueOnce(chain([])),
      insert: jest.fn(),
    } as unknown as Db;
    const service = new ClientOnboardingService(db, audit as never);

    await expect(service.createItem("org-1", actor, {
      clientId: 7,
      title: "Assign owner",
      assignedTo: "outsider",
      sortOrder: 0,
    })).rejects.toThrow("Assignee is not an active organization member");
    expect((db as unknown as { insert: jest.Mock }).insert).not.toHaveBeenCalled();
  });
});
