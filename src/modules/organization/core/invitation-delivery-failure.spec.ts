import { Logger } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";

const mockRunInNewTenantTransaction = jest.fn();

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: (...args: unknown[]) => mockRunInNewTenantTransaction(...args),
}));

import { recordDeliveryFailure } from "./invitations.helpers";

const ORG_ID = "org-owner";
const INVITATION_ID = "inv-1";
const DB = {} as unknown as Db;

function silentLogger() {
  const logger = new Logger("test");
  jest.spyOn(logger, "error").mockImplementation(() => undefined);
  return logger;
}

describe("recordDeliveryFailure", () => {
  beforeEach(() => mockRunInNewTenantTransaction.mockReset());

  it("records DELIVERY_FAILED in a transaction of its own, scoped to the invitation's org", async () => {
    const inserted: unknown[] = [];
    const tx = {
      insert: jest.fn().mockReturnValue({
        values: jest.fn((row: unknown) => {
          inserted.push(row);
          return Promise.resolve(undefined);
        }),
      }),
    };
    mockRunInNewTenantTransaction.mockImplementation(
      (_db: unknown, _orgId: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );

    await recordDeliveryFailure(DB, silentLogger(), ORG_ID, INVITATION_ID, new Error("smtp down"));

    expect(mockRunInNewTenantTransaction).toHaveBeenCalledTimes(1);
    expect(mockRunInNewTenantTransaction.mock.calls[0][1]).toBe(ORG_ID);
    expect(inserted).toEqual([
      {
        orgId: ORG_ID,
        invitationId: INVITATION_ID,
        event: "DELIVERY_FAILED",
        actorMembershipId: null,
      },
    ]);
  });

  it("never joins an ambient transaction, which after a fire-and-forget send has already committed", async () => {
    mockRunInNewTenantTransaction.mockResolvedValue(undefined);

    await recordDeliveryFailure(DB, silentLogger(), ORG_ID, INVITATION_ID, new Error("smtp down"));

    const runInTenantTransaction: unknown = (
      jest.requireMock("../../../common/tenant/run-in-tenant-transaction") as Record<
        string,
        unknown
      >
    ).runInTenantTransaction;
    expect(runInTenantTransaction).toBeUndefined();
    expect(mockRunInNewTenantTransaction).toHaveBeenCalledTimes(1);
  });

  it("never rethrows, so a failed recording cannot roll back or fail the invitation", async () => {
    mockRunInNewTenantTransaction.mockRejectedValue(new Error("42501"));

    await expect(
      recordDeliveryFailure(DB, silentLogger(), ORG_ID, INVITATION_ID, new Error("smtp down")),
    ).resolves.toBeUndefined();
  });
});
