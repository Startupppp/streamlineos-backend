import { Test } from "@nestjs/testing";
import { OrgSetupCompletedConsumerService } from "../org-setup-completed-consumer.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { OnboardingSessionService } from "../../../hr/onboarding/flow/onboarding-session.service";
import { ModuleChecklistService } from "../../../hr/onboarding/flow/module-checklist.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { WorkspaceOnboardingService } from "../../onboarding/workspace-onboarding.service";
import { InvitationCreateService } from "../../core/invitation-create.service";
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
  industry: "IT Services",
  invitees: [{ email: "new@acme.test", role: "MEMBER" }],
};

/**
 * `sendInvitations` re-derives the actor's standing from `organization_members` rather than
 * trusting the payload, so the double has to answer the select chain as well as the users lookup.
 */
function membershipSelect(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockResolvedValue(rows);
  return jest.fn().mockReturnValue(chain);
}

async function build(overrides: {
  completeSession?: jest.Mock;
  ensureChecklistsForModules?: jest.Mock;
  actorRows?: unknown[];
} = {}) {
  const completeSession = overrides.completeSession ?? jest.fn().mockResolvedValue(undefined);
  const skipSession = jest.fn().mockResolvedValue(undefined);
  const ensureChecklistsForModules =
    overrides.ensureChecklistsForModules ?? jest.fn().mockResolvedValue(undefined);
  const emit = jest.fn().mockResolvedValue(undefined);
  const register = jest.fn();
  const generateWorkspace = jest.fn().mockResolvedValue({
    businessUnits: 1,
    branches: 1,
    departments: 4,
    teams: 4,
  });
  const bulkInvite = jest.fn().mockResolvedValue({ results: [] });
  const findFirst = jest
    .fn()
    .mockResolvedValue({ email: "owner@acme.test", name: "Acme Owner", firstName: null });

  const moduleRef = await Test.createTestingModule({
    providers: [
      OrgSetupCompletedConsumerService,
      {
        provide: DRIZZLE,
        useValue: {
          query: { users: { findFirst } },
          select: membershipSelect(overrides.actorRows ?? [{ isOwner: true }]),
        },
      },
      {
        provide: OnboardingSessionService,
        useValue: { completeSession, skipSession },
      },
      { provide: ModuleChecklistService, useValue: { ensureChecklistsForModules } },
      { provide: NotificationDispatchService, useValue: { emit } },
      { provide: OutboxConsumerRegistry, useValue: { register } },
      { provide: WorkspaceOnboardingService, useValue: { generateWorkspace } },
      { provide: InvitationCreateService, useValue: { bulkInvite } },
    ],
  }).compile();

  return {
    svc: moduleRef.get(OrgSetupCompletedConsumerService),
    completeSession,
    skipSession,
    ensureChecklistsForModules,
    emit,
    register,
    generateWorkspace,
    bulkInvite,
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

  // Decision D17 — these two used to be sequenced by the browser after the response returned.
  it("generates the industry workspace structure and sends the wizard's invitations", async () => {
    const { svc, generateWorkspace, bulkInvite } = await build();

    await svc.handle(event(COMPLETE_PAYLOAD));

    expect(generateWorkspace).toHaveBeenCalledWith("org-1", "IT Services", ["hr", "crm"]);
    expect(bulkInvite).toHaveBeenCalledWith(
      "org-1",
      { userId: "user-1", isOrgOwner: true },
      ["new@acme.test"],
      "MEMBER",
      "enqueue",
    );
  });

  it("groups invitations by role so one bulk call is made per role", async () => {
    const { svc, bulkInvite } = await build();

    await svc.handle(
      event({
        ...COMPLETE_PAYLOAD,
        invitees: [
          { email: "a@acme.test", role: "MEMBER" },
          { email: "b@acme.test", role: "ORG_ADMIN" },
          { email: "c@acme.test", role: "MEMBER" },
        ],
      }),
    );

    expect(bulkInvite).toHaveBeenCalledTimes(2);
    expect(bulkInvite).toHaveBeenCalledWith(
      "org-1",
      expect.anything(),
      ["a@acme.test", "c@acme.test"],
      "MEMBER",
      "enqueue",
    );
    expect(bulkInvite).toHaveBeenCalledWith(
      "org-1",
      expect.anything(),
      ["b@acme.test"],
      "ORG_ADMIN",
      "enqueue",
    );
  });

  it("deduplicates setup invitees before enqueuing delivery", async () => {
    const { svc, bulkInvite } = await build();

    await svc.handle(
      event({
        ...COMPLETE_PAYLOAD,
        invitees: [
          { email: "duplicate@acme.test", role: "MEMBER" },
          { email: "DUPLICATE@ACME.TEST", role: "ORG_ADMIN" },
        ],
      }),
    );

    expect(bulkInvite).toHaveBeenCalledTimes(1);
    expect(bulkInvite).toHaveBeenCalledWith(
      "org-1",
      expect.anything(),
      ["duplicate@acme.test"],
      "MEMBER",
      "enqueue",
    );
  });

  it("catches a missing-actor failure in sendInvitations as optional and still closes the session", async () => {
    const { svc, bulkInvite, completeSession, emit } = await build({ actorRows: [] });

    await svc.handle(event(COMPLETE_PAYLOAD));

    expect(bulkInvite).not.toHaveBeenCalled();
    expect(completeSession).toHaveBeenCalledWith("org-1", "user-1", "org_setup");
    expect(emit).toHaveBeenCalled();
    expect(markProcessed).toHaveBeenCalledWith(
      "organization:setup-completed",
      expect.any(String),
      "COMPLETED",
      expect.stringContaining("no active membership"),
    );
    expect(markProcessed).not.toHaveBeenCalledWith(
      "organization:setup-completed",
      expect.any(String),
      "FAILED",
      expect.anything(),
    );
  });

  // A missing industry template is a permanent precondition miss, not a transient failure:
  // dead-lettering the event would discard five successful steps.
  it("skips workspace generation for an industry with no template instead of failing the event", async () => {
    const { svc, generateWorkspace, completeSession } = await build();

    await svc.handle(event({ ...COMPLETE_PAYLOAD, industry: "Cryptozoology" }));

    expect(generateWorkspace).not.toHaveBeenCalled();
    expect(completeSession).toHaveBeenCalled();
    expect(markProcessed).toHaveBeenCalledWith(
      "organization:setup-completed",
      expect.any(String),
      "COMPLETED",
      null,
    );
  });

  // An event emitted by the previous release carries neither field; requiring them would mark
  // every one of those FAILED at boot instead of provisioning it.
  it("provisions an event that predates the industry and invitees fields", async () => {
    const { svc, generateWorkspace, bulkInvite, completeSession } = await build();
    const legacy: Record<string, unknown> = { ...COMPLETE_PAYLOAD };
    delete legacy["industry"];
    delete legacy["invitees"];

    await svc.handle(event(legacy));

    expect(completeSession).toHaveBeenCalled();
    expect(generateWorkspace).not.toHaveBeenCalled();
    expect(bulkInvite).not.toHaveBeenCalled();
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

  it("required phase failure (ensureChecklistsForModules) marks FAILED, rethrows, and does not close the session", async () => {
    const { svc, ensureChecklistsForModules, completeSession } = await build({
      ensureChecklistsForModules: jest.fn().mockRejectedValue(new Error("checklist failed")),
    });

    await expect(svc.handle(event(COMPLETE_PAYLOAD))).rejects.toThrow("checklist failed");
    expect(seedSystemRolesForOrg).toHaveBeenCalled();
    expect(ensureChecklistsForModules).toHaveBeenCalled();
    expect(completeSession).not.toHaveBeenCalled();
    expect(markProcessed).toHaveBeenCalledWith(
      "organization:setup-completed",
      expect.any(String),
      "FAILED",
      "checklist failed",
    );
    expect(markProcessed).not.toHaveBeenCalledWith(
      "organization:setup-completed",
      expect.any(String),
      "COMPLETED",
      expect.anything(),
    );
  });

  it("catches a partial bulk-invite failure as optional, records it in lastError, and still completes the session", async () => {
    const { svc, bulkInvite, completeSession, emit } = await build();
    bulkInvite.mockResolvedValueOnce({
      results: [
        { email: "new@acme.test", success: false, error: "delivery failed" },
      ],
    });

    await svc.handle(event(COMPLETE_PAYLOAD));

    expect(completeSession).toHaveBeenCalledWith("org-1", "user-1", "org_setup");
    expect(emit).toHaveBeenCalled();
    expect(markProcessed).toHaveBeenCalledWith(
      "organization:setup-completed",
      expect.any(String),
      "COMPLETED",
      expect.stringContaining("sendInvitations"),
    );
    expect(markProcessed).not.toHaveBeenCalledWith(
      "organization:setup-completed",
      expect.any(String),
      "FAILED",
      expect.anything(),
    );
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

  it("optional phase failure: generateStructure throws — session closes, sendWelcome runs, COMPLETED recorded", async () => {
    const { svc, generateWorkspace, completeSession, emit } = await build();
    generateWorkspace.mockRejectedValueOnce(new Error("workspace generation failed"));

    await svc.handle(event(COMPLETE_PAYLOAD));

    expect(completeSession).toHaveBeenCalledWith("org-1", "user-1", "org_setup");
    expect(emit).toHaveBeenCalled();
    expect(markProcessed).toHaveBeenCalledWith(
      "organization:setup-completed",
      expect.any(String),
      "COMPLETED",
      expect.stringContaining("generateStructure"),
    );
    expect(markProcessed).not.toHaveBeenCalledWith(
      "organization:setup-completed",
      expect.any(String),
      "FAILED",
      expect.anything(),
    );
  });

  it("optional phase failure: sendWelcome throws — COMPLETED recorded, no rethrow", async () => {
    const { svc, completeSession, emit } = await build();
    emit.mockRejectedValueOnce(new Error("notification dispatch failed"));

    await svc.handle(event(COMPLETE_PAYLOAD));

    expect(completeSession).toHaveBeenCalledWith("org-1", "user-1", "org_setup");
    expect(markProcessed).toHaveBeenCalledWith(
      "organization:setup-completed",
      expect.any(String),
      "COMPLETED",
      expect.stringContaining("sendWelcome"),
    );
    expect(markProcessed).not.toHaveBeenCalledWith(
      "organization:setup-completed",
      expect.any(String),
      "FAILED",
      expect.anything(),
    );
  });

  it("OS6 regression lock: ensureChecklistsForModules is called exactly once per provisioning pass", async () => {
    const { svc, ensureChecklistsForModules } = await build();

    await svc.handle(event(COMPLETE_PAYLOAD));

    expect(ensureChecklistsForModules).toHaveBeenCalledTimes(1);
    expect(ensureChecklistsForModules).toHaveBeenCalledWith("org-1", ["hr", "crm"]);
  });
});
