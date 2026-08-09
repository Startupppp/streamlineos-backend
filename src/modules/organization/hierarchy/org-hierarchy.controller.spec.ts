import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ListQueryInput } from "./dto/org-hierarchy.schemas";
import { OrgHierarchyController } from "./org-hierarchy.controller";
import type { OrgHierarchyService } from "./org-hierarchy.service";

describe("OrgHierarchyController list pagination", () => {
  it("forwards validated list queries for locations and cost centers", () => {
    const page = { data: [], total: 0, page: 2, limit: 25 };
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
      page: 2,
      limit: 25,
      search: "north",
      status: "ACTIVE",
    };

    expect(controller.listLocations(query, currentUser)).toBe(page);
    expect(controller.listCostCenters(query, currentUser)).toBe(page);
    expect(service.listLocations).toHaveBeenCalledWith("org-1", query);
    expect(service.listCostCenters).toHaveBeenCalledWith("org-1", query);
  });
});
