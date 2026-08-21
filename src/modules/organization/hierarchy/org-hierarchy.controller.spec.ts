import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Request } from "express";
import type { ListQueryInput } from "./dto/org-hierarchy.schemas";
import { OrgHierarchyController } from "./org-hierarchy.controller";
import type { OrgHierarchyService } from "./org-hierarchy.service";

describe("OrgHierarchyController cursor lists", () => {
  it("forwards validated list queries for locations and cost centers", () => {
    const page = {
      data: [],
      pageInfo: { limit: 25, hasMore: false, nextCursor: null },
    };
    const service = {
      listLocations: jest.fn().mockReturnValue(page),
      listCostCenters: jest.fn().mockReturnValue(page),
    };
    const controller = new OrgHierarchyController(
      service as unknown as OrgHierarchyService,
    );
    const currentUser = {
      orgId: "org-1",
      userId: "user-1",
    } as CurrentUserContext;
    const query: ListQueryInput = {
      cursor: "cursor-2",
      limit: 25,
      search: "north",
      status: "ACTIVE",
    };

    expect(controller.listLocations(query, currentUser)).toBe(page);
    expect(controller.listCostCenters(query, currentUser)).toBe(page);
    expect(service.listLocations).toHaveBeenCalledWith("org-1", query);
    expect(service.listCostCenters).toHaveBeenCalledWith("org-1", query);
  });

  it("forwards the guard-resolved scope and actor to cached hierarchy reads", () => {
    const service = {
      getHierarchy: jest.fn().mockReturnValue({ departments: 1 }),
      getTree: jest.fn().mockReturnValue([]),
    };
    const controller = new OrgHierarchyController(
      service as unknown as OrgHierarchyService,
    );
    const currentUser = {
      orgId: "org-1",
      userId: "user-1",
    } as CurrentUserContext;
    const request = { rbacScope: "team" } as Request;

    controller.getHierarchy(currentUser, request);
    controller.getTree(currentUser, request);

    const cacheContext = { actorUserId: "user-1", scope: "team" };
    expect(service.getHierarchy).toHaveBeenCalledWith("org-1", cacheContext);
    expect(service.getTree).toHaveBeenCalledWith("org-1", cacheContext);
  });
});
