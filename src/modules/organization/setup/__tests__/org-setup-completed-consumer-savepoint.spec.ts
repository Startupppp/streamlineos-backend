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
import { runWithTenantContext } from "../../../../common/tenant/tenant-context";
import type { TenantTx } from "../../../../db/drizzle.types";

/**
 * A transaction that behaves the way PostgreSQL actually does: one failed statement puts the
 * whole transaction in the aborted state, every later statement raises 25P02, and only a
 * ROLLBACK TO SAVEPOINT restores it. `savepoint()` is what a nested postgres-js transaction is.
 */
class AbortableTransaction {
  aborted = false;
  readonly applied: string[] = [];
  readonly refused: string[] = [];

  statement(label: string): void {
    if (this.aborted) {
      this.refused.push(label);
      throw new Error(
        "current transaction is aborted, commands ignored until end of transaction block (25P02)",
      );
    }
    this.applied.push(label);
  }

  failingStatement(label: string, code: string): never {
    if (this.aborted) {
      this.refused.push(label);
      throw new Error(
        "current transaction is aborted, commands ignored until end of transaction block (25P02)",
      );
    }
    this.aborted = true;
    throw new Error(`${label} rejected: ${code}`);
  }

  async transaction<T>(fn: (tx: AbortableTransaction) => Promise<T>): Promise<T> {
    const entryState = this.aborted;
    try {
      return await fn(this);
    } catch (error) {
      this.aborted = entryState;
      throw error;
    }
  }
}

let activeTx: AbortableTransaction;

const claim = jest.fn().mockResolvedValue(true);
const markProcessedCalls: Array<{ status: string; lastError: string | null }> = [];
const markProcessed = jest
  .fn()
  .mockImplementation(
    async (
      _consumer: string,
      _eventId: string,
      status: "COMPLETED" | "FAILED" | "SKIPPED",
      lastError: string | null = null,
    ) => {
      activeTx.statement(`inbox:${status}`);
      markProcessedCalls.push({ status, lastError });
    },
  );

jest.mock("../../../../common/outbox/inbox-consumer", () => ({
  InboxConsumer: jest.fn().mockImplementation(() => ({ claim, markProcessed })),
}));

const seedSystemRolesForOrg = jest.fn();
jest.mock("../../../rbac/seed-system-roles", () => ({
  seedSystemRolesForOrg: (...args: unknown[]) => seedSystemRolesForOrg(...args),
}));

function event(payload: Record<string, unknown>): OutboxEventRow {
  return {
    eventId: "22222222-2222-4222-8222-222222222222",
    organizationId: "org-1",
    aggregateType: "organization",
    aggregateId: "org-1",
    aggregateVersion: 1,
    eventType: "organization.setup.completed",
    payload,
    occurredAt: new Date(),
  } as unknown as OutboxEventRow;
}

const PAYLOAD = {
  orgId: "org-1",
  userId: "user-1",
  moduleKeys: ["hr", "crm"],
  sessionAction: "complete",
  skipReason: null,
  sendWelcome: true,
  industry: "IT Services",
  invitees: [
    { email: "a@acme.test", role: "MEMBER" },
    { email: "b@acme.test", role: "MEMBER" },
  ],
};

function selectRows(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockImplementation(async () => {
    activeTx.statement("select:actor-membership");
    return rows;
  });
  return jest.fn().mockReturnValue(chain);
}

async function build(
  overrides: { bulkInvite?: jest.Mock; seededRoles?: boolean } = {},
) {
  const bulkInvite =
    overrides.bulkInvite ??
    jest.fn().mockImplementation(async (_org, _actor, emails: string[]) => {
      activeTx.statement(`invite:${emails.join(",")}`);
      return { results: emails.map((email, index) => ({
        email,
        success: true,
        invitationId: `inv-${index}-${email}`,
        deliveryQueued: true,
      })) };
    });
  const generateWorkspace = jest.fn().mockImplementation(async () => {
    activeTx.statement("workspace");
    return { businessUnits: 1, branches: 1, departments: 4, teams: 4 };
  });
  const completeSession = jest.fn().mockImplementation(async () => {
    activeTx.statement("session:complete");
  });
  const ensureChecklistsForModules = jest.fn().mockImplementation(async () => {
    activeTx.statement("checklists");
  });
  const emit = jest.fn().mockImplementation(async () => {
    activeTx.statement("welcome");
  });
  const findFirst = jest.fn().mockImplementation(async () => {
    activeTx.statement("select:user");
    return { email: "owner@acme.test", name: "Acme Owner", firstName: null };
  });
  const select = jest
    .fn()
    .mockImplementationOnce(
      selectRows(overrides.seededRoles === false ? [] : [{ id: 1 }]),
    )
    .mockImplementation(
      selectRows([{ isOwner: true, email: "owner@acme.test" }]),
    );
  const onConflictDoNothing = jest.fn().mockImplementation(async () => {
    activeTx.statement("receipts");
  });
  const values = jest.fn().mockReturnValue({ onConflictDoNothing });
  const insert = jest.fn().mockReturnValue({ values });

  const moduleRef = await Test.createTestingModule({
    providers: [
      OrgSetupCompletedConsumerService,
      {
        provide: DRIZZLE,
        useValue: {
          query: { users: { findFirst } },
          select,
          insert,
        },
      },
      {
        provide: OnboardingSessionService,
        useValue: { completeSession, skipSession: jest.fn() },
      },
      { provide: ModuleChecklistService, useValue: { ensureChecklistsForModules } },
      { provide: NotificationDispatchService, useValue: { emit } },
      { provide: OutboxConsumerRegistry, useValue: { register: jest.fn() } },
      { provide: WorkspaceOnboardingService, useValue: { generateWorkspace } },
      { provide: InvitationCreateService, useValue: { bulkInvite } },
    ],
  }).compile();

  return {
    svc: moduleRef.get(OrgSetupCompletedConsumerService),
    bulkInvite,
    generateWorkspace,
    completeSession,
    ensureChecklistsForModules,
    emit,
  };
}

function inRelayTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const tx: TenantTx = activeTx as unknown as TenantTx;
  return runWithTenantContext(
    { orgId: "org-1", audience: "INTERNAL", tx, afterCommit: [] },
    fn,
  );
}

describe("OrgSetupCompletedConsumerService — optional phases run behind a savepoint (OS-R4)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    markProcessedCalls.length = 0;
    activeTx = new AbortableTransaction();
    claim.mockResolvedValue(true);
    seedSystemRolesForOrg.mockImplementation(async () => {
      activeTx.statement("roles");
    });
  });

  it("an optional phase that rejects a statement leaves the relay transaction usable", async () => {
    const bulkInvite = jest.fn().mockImplementation(async (_org, _actor, emails: string[]) => {
      activeTx.failingStatement(`invite:${emails.join(",")}`, "23505");
    });
    const { svc } = await build({ bulkInvite });

    await inRelayTransaction(() => svc.handle(event(PAYLOAD)));

    expect(activeTx.aborted).toBe(false);
    expect(markProcessedCalls).toEqual([
      {
        status: "COMPLETED",
        lastError: expect.stringContaining("sendInvitations") as unknown as string,
      },
    ]);
    expect(activeTx.refused).toEqual([]);
  });

  it("the welcome phase still runs after an earlier optional phase aborted its own savepoint", async () => {
    const bulkInvite = jest.fn().mockImplementation(async (_org, _actor, emails: string[]) => {
      activeTx.failingStatement(`invite:${emails.join(",")}`, "23505");
    });
    const { svc, emit } = await build({ bulkInvite });

    await inRelayTransaction(() => svc.handle(event(PAYLOAD)));

    expect(emit).toHaveBeenCalledTimes(1);
    expect(activeTx.applied).toContain("welcome");
  });

  it("a failing optional phase rolls back only its own writes", async () => {
    const bulkInvite = jest
      .fn()
      .mockImplementationOnce(async (_org, _actor, emails: string[]) => {
        activeTx.statement(`invite:${emails.join(",")}`);
        activeTx.failingStatement("invite:second-write", "23505");
      });
    const { svc } = await build({ bulkInvite });

    await inRelayTransaction(() => svc.handle(event(PAYLOAD)));

    expect(activeTx.aborted).toBe(false);
    expect(activeTx.applied).toContain("workspace");
    expect(activeTx.applied).toContain("session:complete");
    expect(activeTx.applied).toContain("inbox:COMPLETED");
  });

  it("a required phase that aborts still records FAILED durably, then rethrows", async () => {
    const { svc } = await build({ seededRoles: false });
    seedSystemRolesForOrg.mockImplementation(async () => {
      activeTx.failingStatement("roles", "23503");
    });

    await expect(
      inRelayTransaction(() => svc.handle(event(PAYLOAD))),
    ).rejects.toThrow(/roles rejected/);

    expect(markProcessedCalls).toEqual([
      { status: "FAILED", lastError: "roles rejected: 23503" },
    ]);
    expect(activeTx.refused).toEqual([]);
  });

  it("partial batch: the successful role batch survives while the failing one is recorded", async () => {
    const bulkInvite = jest
      .fn()
      .mockImplementation(async (_org, _actor, emails: string[], role: string) => {
        if (role === "ORG_ADMIN") activeTx.failingStatement(`invite:${role}`, "23505");
        activeTx.statement(`invite:${role}`);
        return { results: emails.map((email, index) => ({
          email,
          success: true,
          invitationId: `inv-${index}-${email}`,
          deliveryQueued: true,
        })) };
      });
    const { svc } = await build({ bulkInvite });

    await inRelayTransaction(() =>
      svc.handle(
        event({
          ...PAYLOAD,
          invitees: [
            { email: "a@acme.test", role: "MEMBER" },
            { email: "admin@acme.test", role: "ORG_ADMIN" },
          ],
        }),
      ),
    );

    expect(activeTx.applied).toContain("invite:MEMBER");
    expect(activeTx.aborted).toBe(false);
    expect(markProcessedCalls[0]?.status).toBe("COMPLETED");
    expect(markProcessedCalls[0]?.lastError).toContain("ORG_ADMIN");
  });

  it("per-email failures reported by bulkInvite name the emails and never throw", async () => {
    const bulkInvite = jest.fn().mockImplementation(async () => ({
      results: [
        { email: "a@acme.test", success: true, invitationId: "inv-a", deliveryQueued: true },
        { email: "b@acme.test", success: false, error: "seat limit" },
      ],
    }));
    const { svc } = await build({ bulkInvite });

    await inRelayTransaction(() => svc.handle(event(PAYLOAD)));

    expect(markProcessedCalls[0]?.status).toBe("COMPLETED");
    expect(markProcessedCalls[0]?.lastError).toContain("b@acme.test");
    expect(markProcessedCalls[0]?.lastError).toContain("1 of 2");
  });

  it("crash/replay: a redelivery the inbox fence rejects performs no phase and no duplicate delivery", async () => {
    claim.mockResolvedValueOnce(false);
    const { svc, bulkInvite, emit } = await build();

    await inRelayTransaction(() => svc.handle(event(PAYLOAD)));

    expect(bulkInvite).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(markProcessedCalls).toEqual([]);
    expect(activeTx.applied).toEqual([]);
  });

  it("the welcome notification carries a dedupe key derived from the event, so a replay cannot double-send", async () => {
    const { svc, emit } = await build();

    await inRelayTransaction(() => svc.handle(event(PAYLOAD)));
    const firstKey = emit.mock.calls[0]?.[0]?.dedupeKey;

    jest.clearAllMocks();
    markProcessedCalls.length = 0;
    activeTx = new AbortableTransaction();
    claim.mockResolvedValue(true);
    seedSystemRolesForOrg.mockImplementation(async () => {
      activeTx.statement("roles");
    });
    const second = await build();
    await inRelayTransaction(() => second.svc.handle(event(PAYLOAD)));

    expect(typeof firstKey).toBe("string");
    expect(second.emit.mock.calls[0]?.[0]?.dedupeKey).toBe(firstKey);
  });

  it("with no ambient relay transaction the phases still run inline", async () => {
    const { svc, completeSession } = await build();

    await svc.handle(event(PAYLOAD));

    expect(completeSession).toHaveBeenCalled();
    expect(markProcessedCalls[0]?.status).toBe("COMPLETED");
  });
});
