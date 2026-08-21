import { terminationReasons } from "../../../db/schema/hr/termination-relational-records";
import { syncTerminationReasons } from "./termination-relational-compat";

describe("syncTerminationReasons", () => {
  it("mirrors reasons on the same transaction after the table is available", async () => {
    const insertedValues = jest.fn().mockResolvedValue(undefined);
    const transaction = {
      execute: jest.fn().mockResolvedValue([{ relationAvailable: true }]),
      delete: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      }),
      insert: jest.fn().mockReturnValue({ values: insertedValues }),
    };

    await syncTerminationReasons(
      transaction as never,
      "org-1",
      73,
      ["Policy violation"],
    );

    expect(transaction.delete).toHaveBeenCalledWith(terminationReasons);
    expect(insertedValues).toHaveBeenCalledWith([
      {
        organizationId: "org-1",
        terminationId: 73,
        reason: "Policy violation",
        sortOrder: 0,
      },
    ]);
  });
});
