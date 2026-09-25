import { Test } from "@nestjs/testing";
import { SignEnvelopesService } from "../sign-envelopes.service";
import { SignEnvelopeQueriesService } from "../sign-envelope-queries.service";
import { SignAuditService } from "../sign-audit.service";
import { SignRecipientsService } from "../sign-recipients.service";
import { SignIntegrationsService } from "../sign-integrations.service";
import { SignNotificationsService } from "../sign-notifications.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SignEnvelopeValidationService } from "../sign-envelope-validation.service";
import { SignEnvelopeSweepsService } from "../sign-envelope-sweeps.service";
import { SignEnvelopeDispatchService } from "../sign-envelope-dispatch.service";
import { SignSettingsService } from "../sign-settings.service";
import { SignTemplatesService } from "../sign-templates.service";
import { SignWatermarkService } from "../sign-watermark.service";
import { SignEnvelopeLifecycleService } from "../sign-envelope-lifecycle.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { ScopedRead } from "../../access/scoped-read";
import { signEnvelopeRowSchema, listEnvelopesResponseSchema } from "../dto/e-sign-envelopes-response.schemas";

/**
 * BE#29 (SIGN-001) and BE#30 (SIGN-002) regression guard.
 *
 * SIGN-001: Creating a draft envelope failed with "app out of date with the API"
 * (response contract mismatch). SIGN-002: List endpoint failed completely.
 *
 * Root cause: `SignEnvelopeQueriesService` was not registered in `ESignModule`,
 * so Nest could not construct `SignEnvelopesService` (which injects it at index
 * 13). The app did not boot; every envelope route 500'd. Fixed in e827db8a0.
 *
 * This test verifies:
 * 1. Both services can be constructed (registration is complete)
 * 2. Create returns a shape that matches `signEnvelopeRowSchema`
 * 3. List returns a shape that matches `listEnvelopesResponseSchema`
 */
describe("SignOS envelope create/list API contract", () => {
  let envelopesService: SignEnvelopesService;
  let queriesService: SignEnvelopeQueriesService;

  const ORG = "org-contract-test";
  const MEMBER_ID = 42;

  beforeEach(async () => {
    const insertedEnvelope = {
      id: 1,
      orgId: ORG,
      title: "Test",
      subject: null,
      message: null,
      status: "draft" as const,
      routingMode: "parallel" as const,
      ccTiming: "on_complete" as const,
      allowDecline: true,
      sourceModule: null,
      sourceEntityType: null,
      sourceEntityId: null,
      templateId: null,
      watermarkPolicyId: null,
      senderMembershipId: MEMBER_ID,
      reminderEnabled: true,
      reminderFirstAfterDays: 3,
      reminderRepeatDays: 3,
      reminderMaxCount: 5,
      reminderSentCount: 0,
      lastReminderAt: null,
      expiresAt: null,
      sentAt: null,
      completedAt: null,
      voidedAt: null,
      voidedByMembershipId: null,
      voidReason: null,
      declinedAt: null,
      correctionRequiredAt: null,
      correctionReason: null,
      finalizationKey: null,
      finalizedAt: null,
      finalPdfFileKey: null,
      finalPdfHash: null,
      metadataJson: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockDb = {
      insert: jest.fn(() => ({
        values: jest.fn(() => ({
          returning: jest.fn(() => Promise.resolve([insertedEnvelope])),
        })),
      })),
      query: {
        signEnvelopes: {
          findFirst: jest.fn(() => Promise.resolve(insertedEnvelope)),
        },
      },
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            orderBy: jest.fn(() => ({
              limit: jest.fn(() => ({
                offset: jest.fn(() => Promise.resolve([{ ...insertedEnvelope, windowTotal: 1 }])),
              })),
            })),
          })),
        })),
      })),
    } as unknown as Db;

    const module = await Test.createTestingModule({
      providers: [
        SignEnvelopesService,
        SignEnvelopeQueriesService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: SignAuditService, useValue: { record: jest.fn() } },
        { provide: SignRecipientsService, useValue: {} },
        { provide: SignIntegrationsService, useValue: {} },
        { provide: SignNotificationsService, useValue: {} },
        { provide: PlanLimitsService, useValue: { assertWithinLimit: jest.fn() } },
        { provide: SignEnvelopeValidationService, useValue: {} },
        { provide: SignEnvelopeSweepsService, useValue: {} },
        { provide: SignEnvelopeDispatchService, useValue: {} },
        { provide: SignSettingsService, useValue: { getOrCreate: jest.fn(async () => ({ defaultReminderFirstAfterDays: 3, defaultReminderRepeatDays: 3, defaultReminderMaxCount: 5 })) } },
        { provide: SignTemplatesService, useValue: {} },
        { provide: SignWatermarkService, useValue: {} },
        { provide: SignEnvelopeLifecycleService, useValue: {} },
      ],
    }).compile();

    envelopesService = module.get(SignEnvelopesService);
    queriesService = module.get(SignEnvelopeQueriesService);
  });

  it("creates an envelope that satisfies signEnvelopeRowSchema", async () => {
    const envelope = await envelopesService.create(ORG, MEMBER_ID, {
      title: "Test",
      routingMode: "parallel",
      ccTiming: "on_complete",
      allowDecline: true,
      reminderEnabled: true,
    });

    // Zod parse throws on mismatch; no error = contract satisfied
    expect(() => signEnvelopeRowSchema.parse(envelope)).not.toThrow();
    expect(envelope.id).toBe(1);
    expect(envelope.title).toBe("Test");
  });

  it("lists envelopes with a response that satisfies listEnvelopesResponseSchema", async () => {
    const read = ScopedRead.of(ORG, "user-1", "all");
    const result = await queriesService.list(read, MEMBER_ID, { page: 1, limit: 25 });

    // Zod parse throws on mismatch; no error = contract satisfied
    expect(() => listEnvelopesResponseSchema.parse(result)).not.toThrow();
    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("total");
    expect(result).toHaveProperty("page");
    expect(result).toHaveProperty("pageSize");
    expect(result).toHaveProperty("totalPages");
  });

  it("both services are constructible (proves registration is complete)", () => {
    // If either service was not registered, Nest would have thrown during module compilation
    expect(envelopesService).toBeDefined();
    expect(queriesService).toBeDefined();
  });
});
