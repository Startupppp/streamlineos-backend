import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException } from "@nestjs/common";
import { SignEnvelopesService } from "../sign-envelopes.service";
import { SignEnvelopeValidationService } from "../sign-envelope-validation.service";
import { SignEnvelopeDispatchService } from "../sign-envelope-dispatch.service";
import { SignEnvelopeSweepsService } from "../sign-envelope-sweeps.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { PlanLimitsService } from "../../billing/plan-limits.service";
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

  it("proceeds to insert when within envelope limit", async () => {
    const db = makeDb();
    const planLimits = makePlanLimits(false);
    const svc = await buildModule(db, planLimits);

    await svc.create(ORG, USER, { title: "Contract", routingMode: "parallel" } as Parameters<SignEnvelopesService["create"]>[2]);

    expect(planLimits.assertWithinLimit).toHaveBeenCalledWith(ORG, "signEnvelopes");
    expect(db.insert).toHaveBeenCalled();
  });
});
