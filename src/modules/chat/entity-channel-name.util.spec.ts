import {
  isStaleEntityChannelName,
  resolveEntityChannelName,
} from "./entity-channel-name.util";

describe("entity-channel-name.util", () => {
  describe("isStaleEntityChannelName", () => {
    it("detects auto-generated entity channel names", () => {
      expect(isStaleEntityChannelName("Project: 80", "project", "80")).toBe(true);
      expect(isStaleEntityChannelName("Sprint: 12", "sprint", "12")).toBe(true);
    });

    it("does not flag resolved human-readable names", () => {
      expect(isStaleEntityChannelName("StreamlineOS", "project", "80")).toBe(false);
      expect(isStaleEntityChannelName("Project: StreamlineOS", "project", "80")).toBe(false);
    });
  });

  describe("resolveEntityChannelName", () => {
    const mockDb = {
      query: {
        projects: { findFirst: jest.fn() },
        clients: { findFirst: jest.fn() },
        tickets: { findFirst: jest.fn() },
        sprints: { findFirst: jest.fn() },
        projectReleases: { findFirst: jest.fn() },
        projectIncidents: { findFirst: jest.fn() },
      },
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("resolves project names scoped by org", async () => {
      mockDb.query.projects.findFirst.mockResolvedValue({ name: "StreamlineOS" });
      const name = await resolveEntityChannelName(
        mockDb as never,
        "project",
        "80",
        "org_1",
      );
      expect(name).toBe("StreamlineOS");
      expect(mockDb.query.projects.findFirst).toHaveBeenCalled();
    });

    it("returns null for invalid entity ids", async () => {
      const name = await resolveEntityChannelName(
        mockDb as never,
        "project",
        "abc",
        "org_1",
      );
      expect(name).toBeNull();
      expect(mockDb.query.projects.findFirst).not.toHaveBeenCalled();
    });
  });
});
