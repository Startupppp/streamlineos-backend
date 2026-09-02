import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Test } from "@nestjs/testing";
import { OrgSetupService } from "../org-setup.service";
import { OrgSetupResolverService } from "../org-setup-resolver.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { OnboardingSessionService } from "../../../hr/onboarding/flow/onboarding-session.service";
import { AuditService } from "../../../../common/audit/audit.service";
import { CacheService } from "../../../../common/cache/cache.service";

jest.mock("../../../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../../../common/tenant/with-identity", () => ({
  withIdentity: jest.fn().mockResolvedValue(undefined),
}));

const SETUP_DIR = join(__dirname, "..");
const SERVICE_SOURCE = readFileSync(join(SETUP_DIR, "org-setup.service.ts"), "utf8");
const MODULE_SOURCE = readFileSync(join(SETUP_DIR, "org.module.ts"), "utf8");
const CONSUMER_SOURCE = readFileSync(
  join(SETUP_DIR, "org-setup-completed-consumer.service.ts"),
  "utf8",
);

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
      values: jest.fn().mockImplementation((rows: InsertedRow | InsertedRow[]) => {
        inserted.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
        return {
          onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
          onConflictDoNothing: jest
            .fn()
            .mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
        };
      }),
    }));

  const whereUpdate = jest.fn().mockResolvedValue([]);
  const set = jest.fn().mockReturnValue({ where: whereUpdate });
  const update = jest.fn().mockReturnValue({ set });

  const limit = jest.fn().mockResolvedValue([{ ownerMembershipId: 99 }]);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({
    where,
    then: (resolve: (rows: typeof CATALOG_ROWS) => unknown) => resolve(CATALOG_ROWS),
  });
  const select = jest.fn().mockReturnValue({ from });

  const tx = {
    execute: jest.fn().mockResolvedValue(undefined),
    insert: makeInsert(),
    update,
    select,
  };

  const db = {
    query: {
      organizations: {
        findFirst: jest.fn().mockResolvedValue({ id: "org-1", name: "Acme" }),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ status: "ACTIVE", isOwner: true }),
      },
    },
    insert: makeInsert(),
    transaction: jest
      .fn()
      .mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { db, inserted, tx };
}

async function buildService(db: unknown) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      OrgSetupService,
      OrgSetupResolverService,
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
  describe("the service never schedules the work on a fire-and-forget path", () => {
    it("contains no setImmediate", () => {
      const code = SERVICE_SOURCE.replace(/\/\*\*[\s\S]*?\*\//g, "");
      expect(code).not.toMatch(/\bsetImmediate\s*\(/);
    });

    it("contains no setTimeout, process.nextTick or queueMicrotask", () => {
      const code = SERVICE_SOURCE.replace(/\/\*\*[\s\S]*?\*\//g, "");
      expect(code).not.toMatch(/\bsetTimeout\s*\(/);
      expect(code).not.toMatch(/\bprocess\s*\.\s*nextTick\s*\(/);
      expect(code).not.toMatch(/\bqueueMicrotask\s*\(/);
    });

    it("discards no promise with `void`", () => {
      const code = SERVICE_SOURCE.replace(/\/\*\*[\s\S]*?\*\//g, "");
      expect(code).not.toMatch(/\bvoid\s+[\w.]+\s*\(/);
      expect(code).not.toMatch(/\bvoid\s+this\./);
    });

    it("routes the work through OutboxWriter", () => {
      expect(SERVICE_SOURCE).toContain("OutboxWriter.emit");
    });
  });

  describe("completeSetup", () => {
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
    it("is registered as a provider of OrgModule, or its onModuleInit never runs", () => {
      expect(MODULE_SOURCE).toContain("OrgSetupCompletedConsumerService");
      const providers = /providers:\s*\[([\s\S]*?)\]/.exec(MODULE_SOURCE)?.[1] ?? "";
      expect(providers).toContain("OrgSetupCompletedConsumerService");
    });

    it("declares the exact event type the service emits — a mismatch would dead-letter every setup", () => {
      const declared = /readonly eventType = "([^"]+)"/.exec(CONSUMER_SOURCE)?.[1];
      const emitted = /eventType: "([^"]+)"/.exec(SERVICE_SOURCE)?.[1];
      expect(declared).toBe("organization.setup.completed");
      expect(emitted).toBe(declared);
    });

    it("performs all four post-setup steps that used to run in the setImmediate", () => {
      expect(CONSUMER_SOURCE).toContain("seedSystemRolesForOrg");
      expect(CONSUMER_SOURCE).toContain("ensureChecklistsForModules");
      expect(CONSUMER_SOURCE).toContain("completeSession");
      expect(CONSUMER_SOURCE).toContain("skipSession");
      expect(CONSUMER_SOURCE).toContain("sendWelcome");
    });
  });
});
