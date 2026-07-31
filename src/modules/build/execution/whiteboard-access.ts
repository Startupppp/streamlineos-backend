export type WhiteboardAccessLevel = "none" | "view" | "edit" | "manage";

type ResolveInput = {
  board: {
    createdBy: string | null;
    visibility: "project" | "private" | "public";
  };
  shareRole: "viewer" | "editor" | null;
  user: {
    userId: string;
    isOrgOwner: boolean;
  };
  hasManagePermission: boolean;
};

export function resolveWhiteboardAccess(input: ResolveInput): WhiteboardAccessLevel {
  const { board, shareRole, user, hasManagePermission } = input;

  if (user.isOrgOwner || board.createdBy === user.userId) {
    return "manage";
  }

  if (shareRole === "editor") return "edit";
  if (shareRole === "viewer") return "view";

  if (board.visibility !== "private") {
    return hasManagePermission ? "edit" : "view";
  }

  return "none";
}
