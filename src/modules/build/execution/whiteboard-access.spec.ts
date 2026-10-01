import { resolveWhiteboardAccess } from "./whiteboard-access";

const CREATOR_ID = "user-creator";
const ADMIN_ID = "user-admin";
const MEMBER_ID = "user-member";

const projectBoardByCreator = { createdBy: CREATOR_ID, visibility: "project" as const };
const projectBoardByOther = { createdBy: ADMIN_ID, visibility: "project" as const };
const privateBoard = { createdBy: ADMIN_ID, visibility: "private" as const };
const publicBoard = { createdBy: ADMIN_ID, visibility: "public" as const };

const regularUser = { userId: MEMBER_ID, isOrgOwner: false};

describe("resolveWhiteboardAccess", () => {
  describe("admin/owner bypass", () => {
    it("returns manage for org owner regardless of visibility", () => {
      expect(
        resolveWhiteboardAccess({
          board: privateBoard,
          shareRole: null,
          user: { userId: MEMBER_ID, isOrgOwner: true},
          hasManagePermission: false,
          hasProjectAccess: true,
        }),
      ).toBe("manage");
    });


    it("returns manage for board creator", () => {
      expect(
        resolveWhiteboardAccess({
          board: projectBoardByCreator,
          shareRole: null,
          user: { userId: CREATOR_ID, isOrgOwner: false},
          hasManagePermission: false,
          hasProjectAccess: true,
        }),
      ).toBe("manage");
    });

    it("returns manage for creator even on private board with no share", () => {
      expect(
        resolveWhiteboardAccess({
          board: { createdBy: MEMBER_ID, visibility: "private" },
          shareRole: null,
          user: { userId: MEMBER_ID, isOrgOwner: false},
          hasManagePermission: false,
          hasProjectAccess: true,
        }),
      ).toBe("manage");
    });
  });

  describe("share role takes priority over visibility", () => {
    it("returns edit for editor share role on private board", () => {
      expect(
        resolveWhiteboardAccess({
          board: privateBoard,
          shareRole: "editor",
          user: regularUser,
          hasManagePermission: false,
          hasProjectAccess: true,
        }),
      ).toBe("edit");
    });

    it("returns view for viewer share role on private board", () => {
      expect(
        resolveWhiteboardAccess({
          board: privateBoard,
          shareRole: "viewer",
          user: regularUser,
          hasManagePermission: false,
          hasProjectAccess: true,
        }),
      ).toBe("view");
    });

    it("returns edit for editor share role on public board", () => {
      expect(
        resolveWhiteboardAccess({
          board: publicBoard,
          shareRole: "editor",
          user: regularUser,
          hasManagePermission: false,
          hasProjectAccess: true,
        }),
      ).toBe("edit");
    });
  });

  describe("visibility fallback (no share)", () => {
    it("returns edit for project-visible board with manage permission", () => {
      expect(
        resolveWhiteboardAccess({
          board: projectBoardByOther,
          shareRole: null,
          user: regularUser,
          hasManagePermission: true,
          hasProjectAccess: true,
        }),
      ).toBe("edit");
    });

    it("returns view for project-visible board without manage permission", () => {
      expect(
        resolveWhiteboardAccess({
          board: projectBoardByOther,
          shareRole: null,
          user: regularUser,
          hasManagePermission: false,
          hasProjectAccess: true,
        }),
      ).toBe("view");
    });

    it("returns view for public board without manage permission", () => {
      expect(
        resolveWhiteboardAccess({
          board: publicBoard,
          shareRole: null,
          user: regularUser,
          hasManagePermission: false,
          hasProjectAccess: true,
        }),
      ).toBe("view");
    });

    it("returns none for private board with no share and no privilege", () => {
      expect(
        resolveWhiteboardAccess({
          board: privateBoard,
          shareRole: null,
          user: regularUser,
          hasManagePermission: false,
          hasProjectAccess: true,
        }),
      ).toBe("none");
    });

    it("returns none for private board even with manage permission but no share", () => {
      expect(
        resolveWhiteboardAccess({
          board: privateBoard,
          shareRole: null,
          user: regularUser,
          hasManagePermission: true,
          hasProjectAccess: true,
        }),
      ).toBe("none");
    });
  });

  describe("project visibility means access to the board's project", () => {
    it("returns none for a project-visible board when the caller cannot access the project", () => {
      expect(
        resolveWhiteboardAccess({
          board: projectBoardByOther,
          shareRole: null,
          user: regularUser,
          hasManagePermission: true,
          hasProjectAccess: false,
        }),
      ).toBe("none");
    });

    it("returns view for the same project-visible board once the caller can access the project", () => {
      expect(
        resolveWhiteboardAccess({
          board: projectBoardByOther,
          shareRole: null,
          user: regularUser,
          hasManagePermission: false,
          hasProjectAccess: true,
        }),
      ).toBe("view");
    });

    it("still honours a direct share on a project-visible board for a caller outside the project", () => {
      expect(
        resolveWhiteboardAccess({
          board: projectBoardByOther,
          shareRole: "viewer",
          user: regularUser,
          hasManagePermission: false,
          hasProjectAccess: false,
        }),
      ).toBe("view");
    });

    it("keeps a public board viewable for a caller outside the project", () => {
      expect(
        resolveWhiteboardAccess({
          board: publicBoard,
          shareRole: null,
          user: regularUser,
          hasManagePermission: false,
          hasProjectAccess: false,
        }),
      ).toBe("view");
    });
  });
});
