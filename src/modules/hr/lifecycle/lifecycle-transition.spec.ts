import { ConflictException } from "@nestjs/common";
import {
  transitionResignation,
  transitionTermination,
} from "./lifecycle-transition";

function transitionWriter(returnedRows: unknown[]) {
  const returning = jest.fn().mockResolvedValue(returnedRows);
  const where = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });
  return { writer: { update }, set, where };
}

describe("lifecycle compare-and-set transitions", () => {
  it("increments a resignation version only when the expected row matches", async () => {
    const { writer, set, where } = transitionWriter([{ rowVersion: 8 }]);

    await expect(
      transitionResignation(writer as never, {
        organizationId: "organization-1",
        resignationId: 41,
        currentStatus: "HR_APPROVED",
        currentVersion: 7,
        changes: { status: "FINAL_APPROVED" },
      }),
    ).resolves.toBe(8);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "FINAL_APPROVED",
        rowVersion: expect.anything(),
      }),
    );
    expect(where).toHaveBeenCalledTimes(1);
  });

  it("returns an HTTP 409 conflict when a termination loses the race", async () => {
    const { writer } = transitionWriter([]);

    await expect(
      transitionTermination(writer as never, {
        organizationId: "organization-1",
        terminationId: 73,
        currentStatus: "PENDING_FINAL",
        currentVersion: 3,
        changes: { status: "APPROVED" },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
