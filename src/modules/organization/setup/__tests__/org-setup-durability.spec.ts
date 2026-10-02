import { Test } from "@nestjs/testing";
import { OrgSetupService } from "../org-setup.service";
import { OrgSetupResolverService } from "../org-setup-resolver.service";
import { OrgSetupCompletedConsumerService } from "../org-setup-completed-consumer.service";
import { OrganizationCreationService } from "../../core/organization-creation.service";
import { AccountOrganizationIndexService } from "../../core/account-organization-index.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { OnboardingSessionService } from "../../../hr/onboarding/flow/onboarding-session.service";
import { AuditService } from "../../../../common/audit/audit.service";
import { CacheService } from "../../../../common/cache/cache.service";
import { OutboxWakeSignal } from "../../../../common/outbox/outbox-wake.signal";

jest.mock("../../../../common/rbac/access-mutation-commit", () => ({
  commitAccessChange: jest.fn().mockResolvedValue(undefined),
}));

// The real withIdentity runs fn inside a transaction carrying only the user GUC. The mock must
// invoke fn with the db acting as tx so the caller can use tx.query, tx.insert, tx.update, etc.
// A mock that resolves undefined causes resolveCurrentSetupTarget to fail when it destructures
// the returned Promise.all 2-tuple.
jest.mock("../../../../common/tenant/with-identity", () => ({
  withIdentity: jest
    .fn()
    .mockImplementation(
      (_db: unknown, _userId: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn(_db),
    ),
}));

function ownerActor(orgId = "org-1"): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, true),
  };
}

const CATALOG_ROWS = [
  { moduleKey: "hr", isCore: false },
  { moduleKey: "crm", isCore: false },
  { moduleKey: "build", isCore: false },
  { moduleKey: "kb", isCore: true },
];

type InsertedRow = Record<string, unknown>;

function buildDb() {
  const inserted: { table: unknown; rows: InsertedRow[] }[] = [];

  const makeInsert = () =>
    jest.fn().mockImplementation((table: unknown) => ({
      values: jest
        .fn()
        .mockImplementation((rows: InsertedRow | InsertedRow[]) => {
          inserted.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
          return {
            onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
            onConflictDoNothing: jest
              .fn()
              .mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
          };
        }),
    }));

  // `claimOnboardingStamp` reads `.returning()` off the same chain the plain `users` update
  // awaits directly, so the double has to be both awaitable and chainable.
  const whereUpdate = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue([{ id: "org-1" }]),
    then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
  });
  const set = jest.fn().mockReturnValue({ where: whereUpdate });
  const update = jest.fn().mockReturnValue({ set });

  const limit = jest.fn().mockResolvedValue([{ ownerMembershipId: 99 }]);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({
    where,
    then: (resolve: (rows: typeof CATALOG_ROWS) => unknown) =>
      resolve(CATALOG_ROWS),
  });
  const select = jest.fn().mockReturnValue({ from });

  const query = {
    organizations: {
      findFirst: jest.fn().mockResolvedValue({ id: "org-1", name: "Acme" }),
    },
    organizationMembers: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ status: "ACTIVE", isOwner: true }),
    },
  };

  const tx = {
    execute: jest.fn().mockResolvedValue(undefined),
    insert: makeInsert(),
    update,
    select,
    query,
  };

  const db = {
    query,
    insert: makeInsert(),
    transaction: jest
      .fn()
      .mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) =>
        fn(tx),
      ),
  };

  return { db, inserted, tx };
}

async function buildService(
  db: unknown,
  wakeSignal: { wake: () => void; register: (l: () => void) => void } = {
    wake: jest.fn(),
    register: jest.fn(),
  },
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      OrgSetupService,
      OrgSetupResolverService,
      {
        provide: OrganizationCreationService,
        useValue: { createFromSetup: jest.fn() },
      },
      {
        provide: AccountOrganizationIndexService,
        useValue: {
          activate: jest.fn().mockResolvedValue({ status: "activated" }),
          refreshForUser: jest.fn(),
        },
      },
      { provide: DRIZZLE, useValue: db },
      { provide: AuditService, useValue: { log: jest.fn() } },
      { provide: CacheService, useValue: { invalidate: jest.fn() } },
      {
        provide: OnboardingSessionService,
        useValue: {
          getOrCreateSession: jest.fn().mockResolvedValue({ id: 42 }),
          skipSession: jest.fn().mockResolvedValue(undefined),
          completeSession: jest.fn().mockResolvedValue(undefined),
        },
      },
      { provide: OutboxWakeSignal, useValue: wakeSignal },
    ],
  }).compile();
  return moduleRef.get(OrgSetupService);
}

function outboxRows(inserted: { rows: InsertedRow[] }[]): InsertedRow[] {
  return inserted.flatMap((i) => i.rows).filter((r) => "eventType" in r);
}

describe("org setup post-provisioning is durable, not fire-and-forget", () => {
  // The regression this file exists for. The four post-setup steps — RBAC role seeding, module
  // checklists, closing the setup session, the welcome notification — used to run in a bare
  // `setImmediate` whose only failure handler was a log line, so a crash or a single throw left a
  // brand-new organisation permanently half-provisioned with nothing to retry it.
  describe("the service routes post-setup work through the durable outbox", () => {
    it("emits the outbox event inside the transaction and fires the wake signal after commit", async () => {
      const { db, inserted } = buildDb();
      const wakeSignal = { wake: jest.fn(), register: jest.fn() };
      const svc = await buildService(db, wakeSignal);

      await svc.completeSetup(ownerActor(), {
        industry: "IT Services",
        companySize: "1-10",
        enabledModules: ["hr"],
      } as Parameters<OrgSetupService["completeSetup"]>[1]);

      expect(outboxRows(inserted)).toHaveLength(1);
      expect(wakeSignal.wake).toHaveBeenCalledTimes(1);
    });

    it("does NOT fire the wake signal when the onboarding stamp was already claimed (idempotent re-submit)", async () => {
      const { db, tx } = buildDb();
      tx.update = jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([]),
            then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
          }),
        }),
      });
      const wakeSignal = { wake: jest.fn(), register: jest.fn() };
      const svc = await buildService(db, wakeSignal);

      await svc.completeSetup(ownerActor(), {
        fullName: "Priya Raman",
        industry: "IT Services",
        companySize: "1-10",
        enabledModules: [],
      } as Parameters<OrgSetupService["completeSetup"]>[1]);

      expect(wakeSignal.wake).not.toHaveBeenCalled();
    });
  });

  describe("completeSetup", () => {
    it("emits Build MEMBER for an omitted grant on new Member invites and preserves explicit opt-out", async () => {
      const { db, inserted } = buildDb();
      const svc = await buildService(db);

      await svc.completeSetup(ownerActor(), {
        fullName: "Asha Rao",
        industry: "IT Services",
        companySize: "1-10",
        enabledModules: ["build", "hr"],
        invitees: [
          { email: "builder@acme.test", role: "MEMBER" },
          { email: "later@acme.test", role: "MEMBER", moduleAccess: [] },
          { email: "admin@acme.test", role: "ORG_ADMIN" },
        ],
      });

      expect(outboxRows(inserted)[0]?.payload).toMatchObject({
        invitees: [
          { email: "builder@acme.test", role: "MEMBER", moduleAccess: [{ moduleKey: "build", standing: "MEMBER" }] },
          { email: "later@acme.test", role: "MEMBER", moduleAccess: [] },
          { email: "admin@acme.test", role: "ORG_ADMIN" },
        ],
      });
    });

    it("emits organization.setup.completed into the outbox inside the setup transaction", async () => {
      const { db, inserted } = buildDb();
      const svc = await buildService(db);

      await svc.completeSetup(ownerActor(), {
        industry: "IT Services",
        companySize: "1-10",
        enabledModules: ["hr", "crm"],
      } as Parameters<OrgSetupService["completeSetup"]>[1]);

      const events = outboxRows(inserted);
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event?.eventType).toBe("organization.setup.completed");
      expect(event?.organizationId).toBe("org-1");
      expect(event?.aggregateType).toBe("organization");
      expect(event?.aggregateId).toBe("org-1");
      expect(event?.deliveryState).toBe("PENDING");
      expect(event?.payload).toMatchObject({
        orgId: "org-1",
        userId: "user-1",
        moduleKeys: ["hr", "crm"],
        sessionAction: "complete",
        skipReason: null,
        sendWelcome: true,
      });
    });

    it("writes the event through the same tx handle as the organization update, so it commits atomically", async () => {
      const { db, tx } = buildDb();
      const svc = await buildService(db);

      await svc.completeSetup(ownerActor(), {
        industry: "IT Services",
        companySize: "1-10",
        enabledModules: ["hr"],
      } as Parameters<OrgSetupService["completeSetup"]>[1]);

      // The outbox insert must go through the transaction handle, never the bare `db` — a
      // separate connection would let the event survive a rolled-back setup, or be lost by one.
      expect(tx.insert).toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe("skipSetup", () => {
    it("emits the same durable event with sessionAction=skip and no welcome", async () => {
      const { db, inserted } = buildDb();
      const svc = await buildService(db);

      await svc.skipSetup(ownerActor(), "not now");

      const events = outboxRows(inserted);
      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe("organization.setup.completed");
      expect(events[0]?.payload).toMatchObject({
        sessionAction: "skip",
        skipReason: "not now",
        sendWelcome: false,
      });
    });
  });

  describe("the consumer that performs the work", () => {
    it("is registered as a provider of OrgModule, or its onModuleInit never runs", async () => {
      const { OrgModule } = await import("../org.module");
      const providers =
        (Reflect.getMetadata("providers", OrgModule) as unknown[]) ?? [];
      expect(providers).toContain(OrgSetupCompletedConsumerService);
    });

    it("declares the exact event type the service emits — a mismatch would dead-letter every setup", async () => {
      const { db, inserted } = buildDb();
      const svc = await buildService(db);

      await svc.completeSetup(ownerActor(), {
        industry: "IT Services",
        companySize: "1-10",
        enabledModules: ["hr"],
      } as Parameters<OrgSetupService["completeSetup"]>[1]);

      const emittedType = outboxRows(inserted)[0]?.eventType;

      const consumer = new OrgSetupCompletedConsumerService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { register: jest.fn() } as never,
        {} as never,
        {} as never,
      );
      expect(consumer.eventType).toBe("organization.setup.completed");
      expect(emittedType).toBe(consumer.eventType);
    });

    it("exposes a handle() entry point covering all four post-setup phases", () => {
      // Full behavioral coverage of each phase (roles, checklists, workspace, invitations,
      // session close, welcome) is in __tests__/org-setup-completed-consumer.service.spec.ts.
      const consumer = new OrgSetupCompletedConsumerService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { register: jest.fn() } as never,
        {} as never,
        {} as never,
      );
      expect(typeof consumer.handle).toBe("function");
    });

    it("registers itself with the OutboxConsumerRegistry on onModuleInit", () => {
      const registry = { register: jest.fn() };
      const consumer = new OrgSetupCompletedConsumerService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        registry as never,
        {} as never,
        {} as never,
      );
      consumer.onModuleInit();
      expect(registry.register).toHaveBeenCalledWith(consumer);
    });
  });
});
