import { Test } from "@nestjs/testing";
import { OrgSetupCompletedConsumerService } from "../org-setup-completed-consumer.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { OnboardingSessionService } from "../../../hr/onboarding/flow/onboarding-session.service";
import { ModuleChecklistService } from "../../../hr/onboarding/flow/module-checklist.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import {
  OutboxConsumerRegistry,
  type OutboxEventRow,
} from "../../../../common/outbox/outbox-consumer.registry";

const seedSystemRolesForOrg = jest.fn().mockResolvedValue(undefined);
jest.mock("../../../rbac/seed-system-roles", () => ({
  seedSystemRolesForOrg: (...args: unknown[]) => seedSystemRolesForOrg(...args),
}));

const claim = jest.fn().mockResolvedValue(true);
const markProcessed = jest.fn().mockResolvedValue(undefined);
jest.mock("../../../../common/outbox/inbox-consumer", () => ({
  InboxConsumer: jest.fn().mockImplementation(() => ({ claim, markProcessed })),
}));

function event(payload: Record<string, unknown>): OutboxEventRow {
  return {
    eventId: "11111111-1111-4111-8111-111111111111",
    organizationId: "org-1",
    aggregateType: "organization",
    aggregateId: "org-1",
    aggregateVersion: 1,
    eventType: "organization.setup.completed",
    payload,
    occurredAt: new Date(),
  } as unknown as OutboxEventRow;
}

const COMPLETE_PAYLOAD = {
  orgId: "org-1",
  userId: "user-1",
  moduleKeys: ["hr", "crm"],
  sessionAction: "complete",
  skipReason: null,
  sendWelcome: true,
};

async function build(overrides: {
  completeSession?: jest.Mock;
  ensureChecklistsForModules?: jest.Mock;
} = {}) {
  const completeSession = overrides.completeSession ?? jest.fn().mockResolvedValue(undefined);
  const skipSession = jest.fn().mockResolvedValue(undefined);
  const ensureChecklistsForModules =
    overrides.ensureChecklistsForModules ?? jest.fn().mockResolvedValue(undefined);
  const emit = jest.fn().mockResolvedValue(undefined);
  const register = jest.fn();
  const findFirst = jest
    .fn()
    .mockResolvedValue({ email: "owner@acme.test", name: "Acme Owner", firstName: null });

  const moduleRef = await Test.createTestingModule({
    providers: [
      OrgSetupCompletedConsumerService,
      { provide: DRIZZLE, useValue: { query: { users: { findFirst } } } },
      {
        provide: OnboardingSessionService,
        useValue: { completeSession, skipSession },
      },
      { provide: ModuleChecklistService, useValue: { ensureChecklistsForModules } },
      { provide: NotificationDispatchService, useValue: { emit } },
      { provide: OutboxConsumerRegistry, useValue: { register } },
    ],
  }).compile();

  return {
    svc: moduleRef.get(OrgSetupCompletedConsumerService),
    completeSession,
    skipSession,
    ensureChecklistsForModules,
    emit,
    register,
  };
}

describe("OrgSetupCompletedConsumerService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    claim.mockResolvedValue(true);
    seedSystemRolesForOrg.mockResolvedValue(undefined);
  });

  it("registers itself with the outbox registry on module init", async () => {
    const { svc, register } = await build();
    svc.onModuleInit();
    expect(register).toHaveBeenCalledWith(svc);
  });

  it("declares the event type the setup service emits", async () => {
    const { svc } = await build();
    expect(svc.eventType).toBe("organization.setup.completed");
  });

  it("performs every post-setup step for a completed setup", async () => {
    const { svc, completeSession, ensureChecklistsForModules, emit } = await build();

    await svc.handle(event(COMPLETE_PAYLOAD));

    expect(seedSystemRolesForOrg).toHaveBeenCalledWith(expect.anything(), "org-1");
    expect(ensureChecklistsForModules).toHaveBeenCalledWith("org-1", ["hr", "crm"]);
    expect(completeSession).toHaveBeenCalledWith("org-1", "user-1", "org_setup");
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "organization.setup.completed",
        orgId: "org-1",
        targetUserIds: ["user-1"],
      }),
    );
    expect(markProcessed).toHaveBeenCalledWith(
      "organization:setup-completed",
      expect.any(String),
      "COMPLETED",
      null,
    );
  });

  it("skips the session and sends no welcome for a skipped setup", async () => {
    const { svc, skipSession, completeSession, emit } = await build();

    await svc.handle(
      event({
        ...COMPLETE_PAYLOAD,
        sessionAction: "skip",
        skipReason: "not now",
        sendWelcome: false,
      }),
    );

    expect(skipSession).toHaveBeenCalledWith("org-1", "user-1", "org_setup", "not now");
    expect(completeSession).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  // The whole point of moving off `setImmediate`: a failure must reach the publisher so the
  // event is retried and finally dead-lettered, instead of being written to a log and dropped.
  it("rethrows a failing step so the outbox retries it rather than swallowing it", async () => {
    const boom = new Error("role seeding failed");
    seedSystemRolesForOrg.mockRejectedValueOnce(boom);
    const { svc } = await build();

    await expect(svc.handle(event(COMPLETE_PAYLOAD))).rejects.toThrow("role seeding failed");
    expect(markProcessed).toHaveBeenCalledWith(
      "organization:setup-completed",
      expect.any(String),
      "FAILED",
      "role seeding failed",
    );
  });

  it("rethrows when a later step fails, after the earlier ones ran", async () => {
    const { svc, ensureChecklistsForModules } = await build({
      ensureChecklistsForModules: jest.fn().mockRejectedValue(new Error("checklist failed")),
    });

    await expect(svc.handle(event(COMPLETE_PAYLOAD))).rejects.toThrow("checklist failed");
    expect(seedSystemRolesForOrg).toHaveBeenCalled();
    expect(ensureChecklistsForModules).toHaveBeenCalled();
  });

  it("does no work when the inbox fence says the event was already processed", async () => {
    claim.mockResolvedValueOnce(false);
    const { svc, completeSession } = await build();

    await svc.handle(event(COMPLETE_PAYLOAD));

    expect(seedSystemRolesForOrg).not.toHaveBeenCalled();
    expect(completeSession).not.toHaveBeenCalled();
  });

  it("marks an unparseable payload FAILED without throwing an unhandled error", async () => {
    const { svc, completeSession } = await build();

    await svc.handle(event({ orgId: "org-1" }));

    expect(completeSession).not.toHaveBeenCalled();
    expect(markProcessed).toHaveBeenCalledWith(
      "organization:setup-completed",
      expect.any(String),
      "FAILED",
      expect.any(String),
    );
  });
});
