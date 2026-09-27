import { NotFoundException } from "@nestjs/common";

jest.mock("./tickets-helpers", () => ({
  ...jest.requireActual("./tickets-helpers"),
  readTicketVersionForSystemWrite: jest.fn(),
}));

import { readTicketVersionForSystemWrite } from "./tickets-helpers";
import { ProjectsTicketsService } from "./projects-tickets.service";

const readVersion = jest.mocked(readTicketVersionForSystemWrite);

type UpdateCall = {
  projectId: number | null;
  ticketId: number;
  input: { version?: number; status?: string };
};

function serviceWithRecordingUpdate() {
  const calls: UpdateCall[] = [];
  const update = {
    updateTicket: (
      _u: unknown,
      projectId: number | null,
      ticketId: number,
      input: { version?: number; status?: string },
    ) => {
      calls.push({ projectId, ticketId, input });
      return Promise.resolve({ updated: true });
    },
  };
  const service = Object.create(ProjectsTicketsService.prototype);
  Object.assign(service, { update, db: {} });
  return { service, calls };
}

const ACTOR = { orgId: "org-1", userId: "user-1" };

describe("a system actor with no client token takes the ticket's current version instead of bypassing the compare-and-swap", () => {
  beforeEach(() => readVersion.mockReset());

  it("passes the version it read straight into the single update path, so system writes use the same compare-and-swap as a client write", async () => {
    readVersion.mockResolvedValue(7);
    const { service, calls } = serviceWithRecordingUpdate();

    await service.updateTicketFromSystem(ACTOR, null, 42, { status: "DONE" });

    expect(calls).toHaveLength(1);
    expect(calls[0].input.version).toBe(7);
    expect(calls[0].ticketId).toBe(42);
  });

  it("preserves the caller's own fields rather than replacing the body with just the version", async () => {
    readVersion.mockResolvedValue(3);
    const { service, calls } = serviceWithRecordingUpdate();

    await service.updateTicketFromSystem(ACTOR, null, 42, { status: "DONE" });

    expect(calls[0].input.status).toBe("DONE");
  });

  it("does not write at all when the version read rejects, so an absent or deleted ticket cannot be overwritten", async () => {
    readVersion.mockRejectedValue(new NotFoundException("Ticket not found"));
    const { service, calls } = serviceWithRecordingUpdate();

    await expect(
      service.updateTicketFromSystem(ACTOR, null, 42, { status: "DONE" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(calls).toHaveLength(0);
  });

  it("reads the version for the same ticket it is about to write, not a different one", async () => {
    readVersion.mockResolvedValue(5);
    const { service } = serviceWithRecordingUpdate();

    await service.updateTicketFromSystem(ACTOR, null, 99, { status: "DONE" });

    expect(readVersion).toHaveBeenCalledWith(expect.anything(), "org-1", 99);
  });
});
