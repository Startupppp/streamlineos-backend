import { REQUIRE_PERMISSION } from "../access/require-permission.decorator";
import { ProjectsTicketCommentsController } from "./core/tickets";
import { AgentPulseController } from "./agent-pulse/agent-pulse.controller";
import { CommentDraftsController } from "./comment-drafts/comment-drafts.controller";

function permissionFor(handler: object): string | undefined {
  return Reflect.getMetadata(REQUIRE_PERMISSION, handler);
}

const COMMENT_WRITE_KEY = "build:tickets:update";
const COMMENT_READ_KEY = "build:tickets:view";

describe("Build — a route that materialises a ticket comment costs build:tickets:update", () => {
  it("gates the canonical comment write on the update key", () => {
    expect(permissionFor(ProjectsTicketCommentsController.prototype.addComment)).toBe(
      COMMENT_WRITE_KEY,
    );
  });

  it("charges applying an agent-pulse draft the same key as the canonical write, so a view-only holder cannot compose a draft upsert into a comment", () => {
    expect(permissionFor(AgentPulseController.prototype.applyDraft)).toBe(COMMENT_WRITE_KEY);
  });

  it("still lets a view-only holder stage and discard a private draft, which writes no ticket comment", () => {
    expect(permissionFor(CommentDraftsController.prototype.upsert)).toBe(COMMENT_READ_KEY);
    expect(permissionFor(CommentDraftsController.prototype.listMine)).toBe(COMMENT_READ_KEY);
    expect(permissionFor(CommentDraftsController.prototype.deleteOne)).toBe(COMMENT_READ_KEY);
  });

  it("keeps reading a comment cheaper than writing one, proving the two keys are distinguishable here", () => {
    expect(permissionFor(ProjectsTicketCommentsController.prototype.getComment)).toBe(
      COMMENT_READ_KEY,
    );
    expect(permissionFor(ProjectsTicketCommentsController.prototype.editComment)).toBe(
      COMMENT_WRITE_KEY,
    );
    expect(permissionFor(ProjectsTicketCommentsController.prototype.deleteComment)).toBe(
      COMMENT_WRITE_KEY,
    );
  });
});
