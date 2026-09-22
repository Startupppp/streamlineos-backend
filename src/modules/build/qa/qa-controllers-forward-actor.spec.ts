import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { TestCasesController } from "./test-cases.controller";
import { TestSuitesController } from "./test-suites.controller";
import { TestRunsController } from "./test-runs.controller";
import type { TestManagementService } from "./test-management.service";
import type { TestRunsService } from "./test-runs.service";

const MEMBERSHIP_ID = 7;
const PROJECT_ID = 7;

function makeU(): CurrentUserContext {
  return {
    userId: "user-7",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(MEMBERSHIP_ID, false),
  };
}

function makeManagementSvc() {
  return {
    getCase: jest.fn().mockResolvedValue({ id: 42 }),
    updateCase: jest.fn().mockResolvedValue({ id: 42 }),
    deleteCase: jest.fn().mockResolvedValue({ success: true }),
    updateSuite: jest.fn().mockResolvedValue({ id: 11 }),
    deleteSuite: jest.fn().mockResolvedValue({ success: true }),
  };
}

function makeRunsSvc() {
  return {
    getRun: jest.fn().mockResolvedValue({ id: 5 }),
    listRunResults: jest.fn().mockResolvedValue({ data: [], hasMore: false, nextCursor: null }),
    updateRun: jest.fn().mockResolvedValue({ id: 5 }),
    deleteRun: jest.fn().mockResolvedValue({ success: true }),
    updateResult: jest.fn().mockResolvedValue({ id: 3 }),
    createBugFromResultConsolidated: jest.fn().mockResolvedValue({ id: 88 }),
  };
}

describe("QA by-id controllers forward the whole actor so the service can gate on project membership", () => {
  it("passes the actor, not a bare orgId, from every TestCasesController by-id route", async () => {
    const svc = makeManagementSvc();
    const controller = new TestCasesController(svc as unknown as TestManagementService);
    const u = makeU();

    await controller.getCase(PROJECT_ID, 42, u);
    await controller.updateCase(PROJECT_ID, 42, { title: "renamed" }, u);
    await controller.deleteCase(PROJECT_ID, 42, u);

    expect(svc.getCase).toHaveBeenCalledWith(u, PROJECT_ID, 42);
    expect(svc.updateCase).toHaveBeenCalledWith(u, PROJECT_ID, 42, { title: "renamed" });
    expect(svc.deleteCase).toHaveBeenCalledWith(u, PROJECT_ID, 42);
  });

  it("passes the actor, not a bare orgId, from every TestSuitesController by-id route", async () => {
    const svc = makeManagementSvc();
    const controller = new TestSuitesController(svc as unknown as TestManagementService);
    const u = makeU();

    await controller.updateSuite(PROJECT_ID, 11, { name: "renamed" }, u);
    await controller.deleteSuite(PROJECT_ID, 11, u);

    expect(svc.updateSuite).toHaveBeenCalledWith(u, PROJECT_ID, 11, { name: "renamed" });
    expect(svc.deleteSuite).toHaveBeenCalledWith(u, PROJECT_ID, 11);
  });

  it("passes the actor, not a bare orgId, from every TestRunsController by-id route", async () => {
    const svc = makeRunsSvc();
    const controller = new TestRunsController(svc as unknown as TestRunsService);
    const u = makeU();

    await controller.getRun(PROJECT_ID, 5, u);
    await controller.listRunResults(PROJECT_ID, 5, { limit: 50 }, u);
    await controller.updateRun(PROJECT_ID, 5, { name: "renamed" }, u);
    await controller.deleteRun(PROJECT_ID, 5, u);
    await controller.updateResult(PROJECT_ID, 5, 3, { status: "passed" }, u);
    await controller.createBugFromResult(PROJECT_ID, 5, 3, { description: "broken" }, u);

    expect(svc.getRun).toHaveBeenCalledWith(u, PROJECT_ID, 5);
    expect(svc.listRunResults).toHaveBeenCalledWith(u, PROJECT_ID, 5, { limit: 50 });
    expect(svc.updateRun).toHaveBeenCalledWith(u, PROJECT_ID, 5, { name: "renamed" });
    expect(svc.deleteRun).toHaveBeenCalledWith(u, PROJECT_ID, 5);
    expect(svc.updateResult).toHaveBeenCalledWith(u, PROJECT_ID, 5, 3, { status: "passed" });
    expect(svc.createBugFromResultConsolidated).toHaveBeenCalledWith(u, PROJECT_ID, 5, 3, {
      description: "broken",
    });
  });
});
