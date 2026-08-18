import { HrOrgCatalogService } from "./hr-org-catalog.service";

describe("HrOrgCatalogService structure compatibility", () => {
  const hierarchy = {
    listLocations: jest.fn(),
    createLocation: jest.fn(),
    updateLocation: jest.fn(),
    deleteLocation: jest.fn(),
    listTeams: jest.fn(),
    createTeam: jest.fn(),
    updateTeam: jest.fn(),
    deleteTeam: jest.fn(),
  };
  const service = new HrOrgCatalogService({} as never, hierarchy as never);

  beforeEach(() => jest.clearAllMocks());

  it("uses bounded canonical list contracts", async () => {
    hierarchy.listLocations.mockResolvedValue({ data: [{ id: "location-1" }] });
    hierarchy.listTeams.mockResolvedValue({ data: [{ id: "team-1" }] });

    await expect(service.listLocations("org-1")).resolves.toEqual([
      { id: "location-1" },
    ]);
    await expect(service.listTeams("org-1")).resolves.toEqual([
      { id: "team-1" },
    ]);
    expect(hierarchy.listLocations).toHaveBeenCalledWith("org-1", {
      limit: 100,
      status: "CURRENT",
    });
    expect(hierarchy.listTeams).toHaveBeenCalledWith("org-1", {
      limit: 100,
      status: "CURRENT",
    });
  });

  it("delegates writes with tenant and actor identity", async () => {
    const location = { name: "Mumbai", type: "OFFICE" as const };
    const team = {
      name: "Platform",
      code: "PLATFORM",
      departmentId: "a24de1d4-8e4f-4d3a-903d-f9d2f32e82ba",
    };

    await service.createLocation("org-1", "user-1", location);
    await service.updateLocation("org-1", "user-1", "location-1", {
      status: "ARCHIVED",
    });
    await service.deleteLocation("org-1", "user-1", "location-1");
    await service.createTeam("org-1", "user-1", team);
    await service.updateTeam("org-1", "user-1", "team-1", {
      status: "ARCHIVED",
    });
    await service.deleteTeam("org-1", "user-1", "team-1");

    expect(hierarchy.createLocation).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      location,
    );
    expect(hierarchy.updateLocation).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "location-1",
      { status: "ARCHIVED" },
    );
    expect(hierarchy.deleteLocation).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "location-1",
    );
    expect(hierarchy.createTeam).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      team,
    );
    expect(hierarchy.updateTeam).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "team-1",
      { status: "ARCHIVED" },
    );
    expect(hierarchy.deleteTeam).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "team-1",
    );
  });
});
