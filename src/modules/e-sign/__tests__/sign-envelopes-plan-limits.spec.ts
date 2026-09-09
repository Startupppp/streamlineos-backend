import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException } from "@nestjs/common";
import { SignEnvelopesService } from "../sign-envelopes.service";
import { SignEnvelopeValidationService } from "../sign-envelope-validation.service";
import { SignEnvelopeDispatchService } from "../sign-envelope-dispatch.service";
import { SignEnvelopeSweepsService } from "../sign-envelope-sweeps.service";
import { SignSettingsService } from "../sign-settings.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SignAuditService } from "../sign-audit.service";
import { SignNotificationsService } from "../sign-notifications.service";
import { SignRecipientsService } from "../sign-recipients.service";
import { SignIntegrationsService } from "../sign-integrations.service";

const ORG = "org-sign-limits";
const USER = "user-sign-1";

const makePlanLimits = (deny: boolean): jest.Mocked<Pick<PlanLimitsService, "assertWithinLimit">> => ({
  assertWithinLimit: jest.fn().mockImplementation(() => {
    if (deny) throw new ForbiddenException("Your FREE plan allows 3 sign envelopes. Upgrade your plan to add more.");
    return Promise.resolve();
  }),
});

const makeDb = () => {
  const chain: Record<string, jest.Mock> = {};
  chain.insert = jest.fn().mockReturnValue(chain);
  chain.values = jest.fn().mockReturnValue(chain);
  chain.returning = jest.fn().mockResolvedValue([{
    id: 10,
    orgId: ORG,
    title: "Test",
    status: "draft",
    senderUserId: USER,
    reminderSentCount: 0,
  }]);
  return chain;
};

/**
 * SIGN-P2-03. Deliberately none of 3/3/5 (the column and DTO defaults) and
 * none of 3/2/3 (the template snapshot's), so an assertion on these numbers
 * cannot pass by accidentally agreeing with a hardcoded constant.
 */
const ORG_SETTINGS = {
  defaultReminderFirstAfterDays: 7,
  defaultReminderRepeatDays: 14,
  defaultReminderMaxCount: 2,
};

describe("SignEnvelopesService plan-limit enforcement", () => {
  const buildModule = async (db: Record<string, jest.Mock>, planLimits: Pick<PlanLimitsService, "assertWithinLimit">) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SignEnvelopesService,
        { provide: DRIZZLE, useValue: { ...db, query: { signEnvelopes: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) } } } },
        { provide: PlanLimitsService, useValue: planLimits },
        { provide: SignAuditService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
        { provide: SignNotificationsService, useValue: { sendVoidedToRecipient: jest.fn() } },
        { provide: SignRecipientsService, useValue: { listForEnvelope: jest.fn().mockResolvedValue([]), update: jest.fn() } },
        { provide: SignIntegrationsService, useValue: { emitEnvelopeEvent: jest.fn() } },
        { provide: SignEnvelopeValidationService, useValue: { validate: jest.fn() } },
        { provide: SignEnvelopeDispatchService, useValue: { send: jest.fn(), resend: jest.fn(), applyRecipientOutcome: jest.fn() } },
        { provide: SignEnvelopeSweepsService, useValue: { sendManualReminder: jest.fn(), runReminderSweep: jest.fn(), runExpirationSweep: jest.fn() } },
        { provide: SignSettingsService, useValue: { getOrCreate: jest.fn().mockResolvedValue(ORG_SETTINGS) } },
      ],
    }).compile();

    return module.get(SignEnvelopesService);
  };

  it("throws ForbiddenException when envelope limit is exceeded", async () => {
    const db = makeDb();
    const planLimits = makePlanLimits(true);
    const svc = await buildModule(db, planLimits);

    await expect(
      svc.create(ORG, USER, { title: "Contract", routingMode: "parallel" } as Parameters<SignEnvelopesService["create"]>[2]),
    ).rejects.toThrow(ForbiddenException);

    expect(planLimits.assertWithinLimit).toHaveBeenCalledWith(ORG, "signEnvelopes");
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("lets an explicit cadence override the organisation default", async () => {
    const db = makeDb();
    const svc = await buildModule(db, makePlanLimits(false));

    await svc.create(ORG, USER, {
      title: "Contract",
      routingMode: "parallel",
      reminderFirstAfterDays: 1,
      reminderRepeatDays: 1,
      reminderMaxCount: 9,
    } as Parameters<SignEnvelopesService["create"]>[2]);

    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({
        reminderFirstAfterDays: 1,
        reminderRepeatDays: 1,
        reminderMaxCount: 9,
      }),
    );
  });

  it("takes a zero maximum literally rather than as absence", async () => {
    const db = makeDb();
    const svc = await buildModule(db, makePlanLimits(false));

    /**
     * `reminderMaxCount: 0` means "never remind". `||` would read that as
     * unset and quietly substitute the org's 2, turning an explicit opt-out
     * into two emails to a customer.
     */
    await svc.create(ORG, USER, {
      title: "Contract",
      routingMode: "parallel",
      reminderMaxCount: 0,
    } as Parameters<SignEnvelopesService["create"]>[2]);

    expect(db.values).toHaveBeenCalledWith(expect.objectContaining({ reminderMaxCount: 0 }));
  });

  it("proceeds to insert when within envelope limit", async () => {
    const db = makeDb();
    const planLimits = makePlanLimits(false);
    const svc = await buildModule(db, planLimits);

    await svc.create(ORG, USER, { title: "Contract", routingMode: "parallel" } as Parameters<SignEnvelopesService["create"]>[2]);

    expect(planLimits.assertWithinLimit).toHaveBeenCalledWith(ORG, "signEnvelopes");
    expect(db.insert).toHaveBeenCalled();

    /**
     * SIGN-P2-03. The caller named no cadence, so the organisation's applies.
     * Before this, the DTO substituted 3/3/5 before the service ever saw the
     * request, and the configured cadence was unreachable — which stopped
     * being cosmetic the moment SIGN-P0-01 gave the sweep a scheduler.
     */
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({
        reminderFirstAfterDays: 7,
        reminderRepeatDays: 14,
        reminderMaxCount: 2,
      }),
    );
  });
});
