jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn((_db: unknown, fn: { (): unknown }) => fn()),
}));

import { Test } from "@nestjs/testing";
import { ModuleRef } from "@nestjs/core";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ProjectsTicketsService } from "../../../build/core/projects-tickets.service";
import { ProjectsTicketCommentsService } from "../../../build/core/projects-ticket-comments.service";
import { findConfirmableAction } from ".";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";

const mockedRunInTenantTransaction = jest.mocked(runInTenantTransaction);

const mockActor: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: { kind: "human-session", membershipId: 1, isOrgOwner: false },
};

describe("ticket.updateStatus confirmable action — atomicity contract", () => {
  let moduleRef: ModuleRef;
  let db: Db;
  let mockUpdateTicket: jest.Mock;
  let mockAddComment: jest.Mock;
  let compiledModule: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>["compile"]>>;

  beforeEach(async () => {
    mockUpdateTicket = jest.fn().mockResolvedValue({ updated: true, updatedAt: new Date().toISOString() });
    mockAddComment = jest.fn().mockResolvedValue({ id: 99 });

    compiledModule = await Test.createTestingModule({
      providers: [
        { provide: DRIZZLE, useValue: {} },
        { provide: ProjectsTicketsService, useValue: { updateTicket: mockUpdateTicket } },
        { provide: ProjectsTicketCommentsService, useValue: { addComment: mockAddComment } },
      ],
    }).compile();

    moduleRef = compiledModule.get(ModuleRef);
    db = compiledModule.get<Db>(DRIZZLE);
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await compiledModule.close();
  });

  it("updateTicket and addComment run inside one runInTenantTransaction call on the @NoTenantTransaction confirmAction endpoint so addComment failure rolls back the status write atomically", async () => {
    mockAddComment.mockRejectedValue(new Error("comment write failed"));
    const action = findConfirmableAction("ticket.updateStatus");

    await expect(
      action?.execute(
        { ticketId: 41, status: "IN_REVIEW", reason: "Ready for QA" },
        { actor: mockActor, db, moduleRef, proposalId: 1 },
      ),
    ).rejects.toThrow("comment write failed");

    expect(mockedRunInTenantTransaction).toHaveBeenCalledTimes(1);
    expect(mockedRunInTenantTransaction).toHaveBeenCalledWith(
      db,
      expect.any(Function),
      { orgId: mockActor.orgId },
    );
    expect(mockUpdateTicket).toHaveBeenCalledTimes(1);
    expect(mockAddComment).toHaveBeenCalledTimes(1);
  });

  it("neither write escapes the transaction callback, so a transaction that never opens performs no partial status update", async () => {
    mockedRunInTenantTransaction.mockImplementation(() => Promise.resolve());
    const action = findConfirmableAction("ticket.updateStatus");

    await action?.execute(
      { ticketId: 41, status: "IN_REVIEW", reason: "Ready for QA" },
      { actor: mockActor, db, moduleRef, proposalId: 1 },
    );

    expect(mockedRunInTenantTransaction).toHaveBeenCalledTimes(1);
    expect(mockUpdateTicket).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
  });
});
