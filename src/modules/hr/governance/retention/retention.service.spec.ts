import { ConflictException } from "@nestjs/common";
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
});
