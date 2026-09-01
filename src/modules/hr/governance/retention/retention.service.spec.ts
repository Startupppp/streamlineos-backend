import { ConflictException, NotFoundException } from "@nestjs/common";
import { RetentionService } from "./retention.service";

function selectRequest(row: Record<string, unknown>) {
  const chain = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.limit.mockResolvedValue([row]);
  return chain;
}

function selectRows(rows: unknown[]) {
  const chain = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.limit.mockResolvedValue(rows);
  return chain;
}

describe("RetentionService correction processing", () => {
  it("does not complete a correction request without field-level processing", async () => {
    const select = selectRequest({
      id: 7,
      orgId: "org-1",
      subjectUserId: "user-1",
      type: "correction",
      status: "approved",
      reason: "Correct legal name",
      deletedAt: null,
    });
    const db = { select: jest.fn().mockReturnValue(select), update: jest.fn() };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new RetentionService(db as never, audit as never);

    await expect(service.processRequest("org-1", 7, "operator-1")).rejects.toBeInstanceOf(ConflictException);
    expect(db.update).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: "data_request.correction_manual_review_required",
    }));
  });

  it("rejects a data request when its subject is outside the organization", async () => {
    const membership = selectRows([]);
    const db = { select: jest.fn().mockReturnValue(membership), insert: jest.fn() };
    const service = new RetentionService(db as never, { log: jest.fn() } as never);

    await expect(
      service.createRequest("org-1", "requester-1", {
        type: "export",
        subjectUserId: "user-outside-org",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("revalidates organization membership before processing an approved request", async () => {
    const request = selectRequest({
      id: 8,
      orgId: "org-1",
      subjectUserId: "user-outside-org",
      type: "delete",
      status: "approved",
      reason: null,
      deletedAt: null,
    });
    const membership = selectRows([]);
    const db = {
      select: jest.fn().mockReturnValueOnce(request).mockReturnValueOnce(membership),
      update: jest.fn(),
    };
    const service = new RetentionService(db as never, { log: jest.fn() } as never);

    await expect(service.processRequest("org-1", 8, "operator-1")).rejects.toBeInstanceOf(NotFoundException);
    expect(db.update).not.toHaveBeenCalled();
  });
});
