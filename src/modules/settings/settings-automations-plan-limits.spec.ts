import { PaymentRequiredException } from "../../common/http/api-exceptions";
import { SettingsAutomationsService } from "./settings-automations.service";
import type { Db } from "../../db/drizzle.module";
import type { PlanLimitsService } from "../billing/core/plan-limits.service";

function stubInsertChain(): { insertSpy: jest.Mock; onConflictDoNothing: jest.Mock; values: jest.Mock } {
  const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
  const returning = jest.fn().mockResolvedValue([{ id: 99 }]);
  const values = jest.fn().mockReturnValue({ onConflictDoNothing, returning });
  return { insertSpy: jest.fn().mockReturnValue({ values }), onConflictDoNothing, values };
}

function makeDb(insertSpy: jest.Mock): Db {
  return {
    insert: insertSpy,
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              offset: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    }),
    query: {
      automationRules: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    },
  } as unknown as Db;
}

const validInput = {
  name: "Test Automation",
  description: "A test automation rule",
  triggerEvent: "ticket.created" as const,
  conditions: [],
  actions: [],
  isEnabled: true,
};

describe("SettingsAutomationsService — createAutomation plan limits", () => {
  it("inserts the automation when assertWithinLimit resolves (plan allows it)", async () => {
    const { insertSpy, values } = stubInsertChain();
    const db = makeDb(insertSpy);
    const planLimits = {
      assertWithinLimit: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlanLimitsService;

    const svc = new SettingsAutomationsService(db, planLimits);
    await svc.createAutomation("org-1", "u-creator", validInput);

    expect(planLimits.assertWithinLimit).toHaveBeenCalledWith("org-1", "automations");
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledTimes(1);
  });

  it("blocks insert when assertWithinLimit rejects (plan limit reached)", async () => {
    const { insertSpy } = stubInsertChain();
    const db = makeDb(insertSpy);
    const planLimits = {
      assertWithinLimit: jest.fn().mockRejectedValue(
        new PaymentRequiredException({ message: "Automation limit reached on your plan." }),
      ),
    } as unknown as PlanLimitsService;

    const svc = new SettingsAutomationsService(db, planLimits);

    await expect(
      svc.createAutomation("org-1", "u-creator", validInput),
    ).rejects.toBeInstanceOf(PaymentRequiredException);

    expect(planLimits.assertWithinLimit).toHaveBeenCalledWith("org-1", "automations");
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("limit check is called before the insert (guard ordering)", async () => {
    const callOrder: string[] = [];
    const { insertSpy } = stubInsertChain();
    const db = makeDb(insertSpy);

    const planLimits = {
      assertWithinLimit: jest.fn().mockImplementation(async () => {
        callOrder.push("assertWithinLimit");
      }),
    } as unknown as PlanLimitsService;

    (insertSpy as jest.Mock).mockImplementation(() => {
      callOrder.push("insert");
      return { values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }) };
    });

    const svc = new SettingsAutomationsService(db, planLimits);
    await svc.createAutomation("org-1", "u-creator", validInput);

    expect(callOrder).toContain("assertWithinLimit");
    expect(callOrder).toContain("insert");
    expect(callOrder.indexOf("assertWithinLimit")).toBeLessThan(
      callOrder.indexOf("insert"),
    );
  });
});
