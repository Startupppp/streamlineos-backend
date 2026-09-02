import { Test } from "@nestjs/testing";
import { OrgSetupCompletedConsumerService } from "../org-setup-completed-consumer.service";
import { orgSetupCompletedPayloadSchema } from "../dto/org-setup-completed-payload.schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { OnboardingSessionService } from "../../../hr/onboarding/flow/onboarding-session.service";
import { ModuleChecklistService } from "../../../hr/onboarding/flow/module-checklist.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import {
  OutboxConsumerRegistry,
  type OutboxEventRow,
} from "../../../../common/outbox/outbox-consumer.registry";

/**
 * Cross-tenant negative tests for the organisation-setup consumer.
 *
 * This consumer provisions an entire organisation — it seeds every system role, provisions the
 * module checklists, closes the setup session and sends the owner's welcome. Every one of those
 * writes takes its `orgId` from the event *payload*, while the inbox fence, the relay's lease and
 * the audit trail are all bound to the outbox row's `organization_id`. The producer sets both
 * from one value (`org-setup.service.ts:emitSetupCompleted`), so the two can only disagree when
 * something has gone wrong — and until this suite existed nothing checked. An event recorded
 * against organisation A carrying a payload naming organisation B would have seeded roles and
 * dispatched a notification inside B.
 *
 * The schema was also a bare `z.object({})`, which strips an unexpected key instead of rejecting
 * it: a producer that renamed `orgId` would have parsed clean with the tenant field simply gone.
 */

const ORG_A = "org-alpha";
const ORG_B = "org-beta";
const USER_A = "user-alpha-owner";

const seedSystemRolesForOrg = jest.fn().mockResolvedValue(undefined);
jest.mock("../../../rbac/seed-system-roles", () => ({
  seedSystemRolesForOrg: (...args: unknown[]) => seedSystemRolesForOrg(...args),
}));

const claim = jest.fn().mockResolvedValue(true);
const markProcessed = jest.fn().mockResolvedValue(undefined);
jest.mock("../../../../common/outbox/inbox-consumer", () => ({
  InboxConsumer: jest.fn().mockImplementation(() => ({ claim, markProcessed })),
}));

function event(
  organizationId: string,
  payload: Record<string, unknown>,
): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: "22222222-2222-4222-8222-222222222222",
    organizationId,
    aggregateType: "organization",
    aggregateId: organizationId,
    aggregateVersion: 1,
    schemaVersion: 1,
    causationId: null,
    correlationId: null,
    actorMembershipId: null,
    audience: "INTERNAL",
    lifecycleState: "ACTIVE",
    deliveryState: "PENDING",
    eventType: "organization.setup.completed",
    payload,
    occurredAt: new Date("2026-09-02T00:00:00.000Z"),
    publishedAt: null,
    leaseExpiresAt: null,
    retryCount: 0,
    lastError: null,
    deadLetteredAt: null,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
  };
}

function payloadFor(orgId: string): Record<string, unknown> {
  return {
    orgId,
    userId: USER_A,
    moduleKeys: ["hr", "crm"],
    sessionAction: "complete",
    skipReason: null,
    sendWelcome: true,
  };
}

async function build() {
  const completeSession = jest.fn().mockResolvedValue(undefined);
  const skipSession = jest.fn().mockResolvedValue(undefined);
  const ensureChecklistsForModules = jest.fn().mockResolvedValue(undefined);
  const emit = jest.fn().mockResolvedValue(undefined);
  const register = jest.fn();
  const findFirst = jest
    .fn()
    .mockResolvedValue({ email: "owner@alpha.test", name: "Alpha Owner", firstName: null });

  const moduleRef = await Test.createTestingModule({
    providers: [
      OrgSetupCompletedConsumerService,
      { provide: DRIZZLE, useValue: { query: { users: { findFirst } } } },
      { provide: OnboardingSessionService, useValue: { completeSession, skipSession } },
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
    findFirst,
  };
}

function provisioningCallCount(mocks: {
  completeSession: jest.Mock;
  skipSession: jest.Mock;
  ensureChecklistsForModules: jest.Mock;
  emit: jest.Mock;
}): number {
  return (
    seedSystemRolesForOrg.mock.calls.length +
    mocks.completeSession.mock.calls.length +
    mocks.skipSession.mock.calls.length +
    mocks.ensureChecklistsForModules.mock.calls.length +
    mocks.emit.mock.calls.length
  );
}

describe("OrgSetupCompletedConsumerService — cross-tenant isolation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    claim.mockResolvedValue(true);
    seedSystemRolesForOrg.mockResolvedValue(undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("control — an event whose payload names its own organization provisions that organization", async () => {
    const mocks = await build();
    await mocks.svc.handle(event(ORG_A, payloadFor(ORG_A)));

    expect(seedSystemRolesForOrg).toHaveBeenCalledTimes(1);
    expect(seedSystemRolesForOrg.mock.calls[0]?.[1]).toBe(ORG_A);
    expect(mocks.ensureChecklistsForModules).toHaveBeenCalledWith(ORG_A, ["hr", "crm"]);
    expect(mocks.completeSession).toHaveBeenCalledWith(ORG_A, USER_A, "org_setup");
    expect(mocks.emit).toHaveBeenCalledTimes(1);
  });

  it("refuses to provision organization B from an event recorded against organization A", async () => {
    const mocks = await build();

    await expect(mocks.svc.handle(event(ORG_A, payloadFor(ORG_B)))).rejects.toThrow(
      /payload orgId does not match the event's organization/,
    );

    expect(provisioningCallCount(mocks)).toBe(0);
  });

  it("names neither organization in any write when the two disagree", async () => {
    const mocks = await build();

    await expect(
      mocks.svc.handle(event(ORG_A, payloadFor(ORG_B))),
    ).rejects.toThrow();

    const everyArgument = JSON.stringify([
      seedSystemRolesForOrg.mock.calls,
      mocks.ensureChecklistsForModules.mock.calls,
      mocks.completeSession.mock.calls,
      mocks.skipSession.mock.calls,
      mocks.emit.mock.calls,
    ]);
    expect(everyArgument).not.toContain(ORG_B);
    expect(everyArgument).not.toContain(ORG_A);
  });

  it("records the refusal durably on the inbox row rather than failing silently", async () => {
    const mocks = await build();

    await expect(
      mocks.svc.handle(event(ORG_A, payloadFor(ORG_B))),
    ).rejects.toThrow();

    expect(markProcessed).toHaveBeenCalledTimes(1);
    const [, , status, reason] = markProcessed.mock.calls[0] ?? [];
    expect(status).toBe("FAILED");
    expect(String(reason)).toContain("does not match the event's organization");
  });

  it("fences the inbox claim on the event's organization, not the payload's", async () => {
    const mocks = await build();
    await mocks.svc.handle(event(ORG_A, payloadFor(ORG_A)));

    const claimed = claim.mock.calls[0]?.[1] as { organizationId?: string } | undefined;
    expect(claimed?.organizationId).toBe(ORG_A);
  });

  it("never reads the subject when it refuses — no cross-tenant identity lookup happens", async () => {
    const mocks = await build();

    await expect(
      mocks.svc.handle(event(ORG_A, payloadFor(ORG_B))),
    ).rejects.toThrow();

    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("a dropped orgId is refused, never defaulted to the event's organization", async () => {
    const mocks = await build();
    const withoutOrg = { ...payloadFor(ORG_A) };
    delete withoutOrg["orgId"];

    await mocks.svc.handle(event(ORG_A, withoutOrg));

    expect(provisioningCallCount(mocks)).toBe(0);
    expect(markProcessed.mock.calls[0]?.[2]).toBe("FAILED");
  });

  it("an unexpected key is rejected by the schema, not stripped and provisioned", async () => {
    const rejected = orgSetupCompletedPayloadSchema.safeParse({
      ...payloadFor(ORG_A),
      targetOrgId: ORG_B,
    });
    expect(rejected.success).toBe(false);

    const mocks = await build();
    await mocks.svc.handle(
      event(ORG_A, { ...payloadFor(ORG_A), targetOrgId: ORG_B }),
    );
    expect(provisioningCallCount(mocks)).toBe(0);
  });

  it("a renamed tenant field parses as a missing one rather than silently losing the tenant", async () => {
    const renamed = { ...payloadFor(ORG_A) };
    delete renamed["orgId"];
    renamed["organizationId"] = ORG_A;

    const parsed = orgSetupCompletedPayloadSchema.safeParse(renamed);
    expect(parsed.success).toBe(false);
  });

  it("does no work at all when the inbox fence says the event was already processed", async () => {
    claim.mockResolvedValue(false);
    const mocks = await build();

    await mocks.svc.handle(event(ORG_A, payloadFor(ORG_B)));

    expect(provisioningCallCount(mocks)).toBe(0);
    expect(markProcessed).not.toHaveBeenCalled();
  });
});
