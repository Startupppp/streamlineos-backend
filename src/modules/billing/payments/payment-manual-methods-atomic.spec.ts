import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { PaymentAuditService } from "./payment-audit.service";
import { PaymentManualMethodsService } from "./payment-manual-methods.service";

describe("manual payment method atomic writes", () => {
  const actor = { orgId: "org-a", userId: "user-a" };

  async function setup() {
    const execute = jest.fn().mockResolvedValue([]);
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const returning = jest.fn().mockResolvedValue([{ id: 1, status: "enabled" }]);
    const values = jest.fn().mockReturnValue({ returning });
    const insert = jest.fn().mockReturnValue({ values });
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const update = jest.fn().mockReturnValue({ set });
    const tx = { execute, query: { paymentManualMethods: { findFirst } }, insert, update };
    const transaction = jest.fn(async (work: (handle: typeof tx) => Promise<unknown>) => work(tx));
    const log = jest.fn().mockResolvedValue(undefined);
    const module = await Test.createTestingModule({ providers: [PaymentManualMethodsService,
      { provide: DRIZZLE, useValue: { transaction } },
      { provide: PaymentAuditService, useValue: { log } },
    ] }).compile();
    return { service: module.get(PaymentManualMethodsService), module, tx, log, execute, findFirst, insert, update, returning };
  }

  it("locks before lookup and passes the same transaction to audit", async () => {
    const fixture = await setup();
    try {
      await fixture.service.create("org-a", { methodType: "cash", displayName: "Cash", requireManualApproval: true }, actor);
      expect(fixture.execute.mock.invocationCallOrder[0]).toBeLessThan(fixture.findFirst.mock.invocationCallOrder[0]);
      expect(fixture.log).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-a", action: "payment_manual_method.created" }), fixture.tx);
      expect(fixture.insert).toHaveBeenCalledTimes(1);
    } finally { await fixture.module.close(); }
  });

  it("updates the existing method under the same lock instead of inserting a duplicate", async () => {
    const fixture = await setup();
    fixture.findFirst.mockResolvedValue({ id: 1 });
    try {
      await fixture.service.create("org-a", { methodType: "cash", displayName: "Cash", requireManualApproval: true }, actor);
      expect(fixture.insert).not.toHaveBeenCalled();
      expect(fixture.update).toHaveBeenCalledTimes(1);
      expect(fixture.log).toHaveBeenCalledWith(expect.objectContaining({ action: "payment_manual_method.updated" }), fixture.tx);
    } finally { await fixture.module.close(); }
  });

  it("propagates audit failure out of the transaction instead of reporting success", async () => {
    const fixture = await setup();
    fixture.log.mockRejectedValueOnce(new Error("audit unavailable"));
    try {
      await expect(fixture.service.create("org-a", { methodType: "cash", displayName: "Cash", requireManualApproval: true }, actor))
        .rejects.toThrow("audit unavailable");
    } finally { await fixture.module.close(); }
  });

  it("a missing or foreign method cannot be disabled or audited as a success", async () => {
    const fixture = await setup();
    fixture.returning.mockResolvedValueOnce([]);
    try {
      await expect(fixture.service.disable("org-a", 99, actor)).rejects.toThrow("Manual payment method not found");
      expect(fixture.log).not.toHaveBeenCalled();
      expect(fixture.findFirst).not.toHaveBeenCalled();
    } finally { await fixture.module.close(); }
  });
});
