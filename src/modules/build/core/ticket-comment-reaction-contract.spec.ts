import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { reactionSchema } from "./dto/build-tickets-response.schemas";
import { ticketCommentReactions } from "../../../db/schema";
import { ProjectsTicketCommentsService } from "./projects-ticket-comments.service";

function buildService(options: { ticket?: { id: number }; comment?: { id: number } }) {
  const { ticket, comment } = options;
  const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
  const values = jest.fn().mockReturnValue({ onConflictDoNothing });
  const insert = jest.fn().mockReturnValue({ values });
  const db = {
    query: {
      tickets: { findFirst: jest.fn().mockResolvedValue(ticket) },
      ticketComments: { findFirst: jest.fn().mockResolvedValue(comment) },
    },
    insert,
  };
  const service = new ProjectsTicketCommentsService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, insert, values, onConflictDoNothing };
}

describe("ProjectsTicketCommentsService.addReaction", () => {
  it("returns the actor-shaped payload the contract declares, not the inserted row", async () => {
    const { service } = buildService({ ticket: { id: 9 }, comment: { id: 42 } });

    const result = await service.addReaction(42, "user-1", "org-1", "👍", 7, 9, 3);

    expect(result).toEqual({ commentId: 42, userId: "user-1", emoji: "👍" });
    expect(reactionSchema.safeParse(result).success).toBe(true);
  });

  it("never asks the insert for the row back, because that row has no userId to return", async () => {
    const { service, values, onConflictDoNothing } = buildService({ ticket: { id: 9 }, comment: { id: 42 } });

    await service.addReaction(42, "user-1", "org-1", "👍", 7, 9, 3);

    expect(values).toHaveBeenCalledWith({ commentId: 42, orgId: "org-1", emoji: "👍", membershipId: 7 });
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(onConflictDoNothing.mock.results[0]?.value).not.toHaveProperty("returning");
  });

  it("refuses a caller with no membership before writing a reaction row", async () => {
    const { service, insert } = buildService({ ticket: { id: 9 }, comment: { id: 42 } });

    await expect(service.addReaction(42, "user-1", "org-1", "👍", null, 9, 3)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it("reports a comment outside the caller's org as missing rather than forbidden", async () => {
    const { service, insert } = buildService({ ticket: { id: 9 }, comment: undefined });

    await expect(service.addReaction(42, "user-1", "other-org", "👍", 7, 9, 3)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it("reports a ticket outside the URL's project as missing, before ever looking at the comment", async () => {
    const { service, insert } = buildService({ ticket: undefined, comment: { id: 42 } });

    await expect(service.addReaction(42, "user-1", "org-1", "👍", 7, 9, 3)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("ProjectsTicketCommentsService.removeReaction", () => {
  it("reports a ticket outside the URL's project as missing, before ever looking at the comment", async () => {
    const { service } = buildService({ ticket: undefined, comment: { id: 42 } });

    await expect(
      service.removeReaction(42, "user-1", "org-1", "👍", 7, 9, 3),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("ticket comment reaction response", () => {
  it("has no userId column on the reaction row, which is why returning the inserted row broke the contract", () => {
    const columns = Object.keys(ticketCommentReactions);

    expect(columns).toContain("membershipId");
    expect(columns).not.toContain("userId");
  });

  it("rejects the raw inserted row, the shape that used to be returned on a first-time reaction", () => {
    const insertedRow = {
      id: 1,
      orgId: "org-1",
      commentId: 42,
      membershipId: 7,
      emoji: "👍",
      createdAt: new Date(),
    };

    expect(reactionSchema.safeParse(insertedRow).success).toBe(false);
  });

  it("accepts the actor-shaped payload the handler now always returns", () => {
    expect(
      reactionSchema.safeParse({ commentId: 42, userId: "user-1", emoji: "👍" }).success,
    ).toBe(true);
  });

  it("requires userId, so a future refactor cannot silently drop the only field identifying who reacted", () => {
    expect(reactionSchema.safeParse({ commentId: 42, emoji: "👍" }).success).toBe(false);
  });
});
