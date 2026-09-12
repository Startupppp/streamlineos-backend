import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as webpush from "web-push";
import type { Db } from "../../db/drizzle.module";
import type { AppConfig } from "../../config/env.validation";
import { ExternalEffectLedger } from "../../common/outbox/external-effect-ledger";
import { WebPushService } from "./web-push.service";

/*
 * `sendToUser` reads and reaps inside `runInTenantTransaction`, because the push
 * path is also reached from background workers with no ambient tenant scope. The
 * scope it names is recorded here and the body runs against the harness db, so
 * the predicate under test is still exactly the one the service builds.
 */
const mockTenantScopes: Array<string | undefined> = [];
jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  ...jest.requireActual<Record<string, unknown>>("../../common/tenant/run-in-tenant-transaction"),
  runInTenantTransaction: (
    db: unknown,
    fn: (tx: unknown) => Promise<unknown>,
    explicit?: { orgId: string },
  ) => {
    mockTenantScopes.push(explicit?.orgId);
    return fn(db);
  },
}));

beforeEach(() => {
  mockTenantScopes.length = 0;
});

/**
 * A person in two organizations holds one push subscription row per organization.
 * Selecting them by user alone hands Org A's notification to the registration the
 * same person made under Org B, and leaves (org_id, membership_id) unusable as an
 * index because its leading column is absent from the predicate.
 */
const dialect = new PgDialect();

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const USER = "user-shared";

// Real keys: the constructor hands them to web-push, which rejects placeholders.
const vapid = webpush.generateVAPIDKeys();
const config = {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  APP_URL: "https://app.example.com",
  EMAIL_FROM_ADDRESS: "noreply@example.com",
} as unknown as AppConfig;

function harness(subscriptions: Array<{ endpoint: string; p256dh: string; auth: string }> = []) {
  const whereClauses: SQL[] = [];
  const deleteWhere: SQL[] = [];
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn((clause: SQL) => {
          whereClauses.push(clause);
          return Promise.resolve(subscriptions);
        }),
      })),
    })),
    delete: jest.fn(() => ({
      where: jest.fn((clause: SQL) => {
        deleteWhere.push(clause);
        return Promise.resolve();
      }),
    })),
  };
  const effects = { execute: jest.fn() } as unknown as ExternalEffectLedger;
  const service = new WebPushService(db as unknown as Db, config, effects);
  return { service, whereClauses, deleteWhere, db };
}

describe("WebPushService — cross-tenant isolation", () => {
  it("DENY: the subscription read is bound to the caller's organization", async () => {
    const { service, whereClauses } = harness();

    await service.sendToUser(OWNER_ORG, USER, { url: "/notifications" });

    expect(whereClauses).toHaveLength(1);
    const rendered = dialect.sqlToQuery(whereClauses[0] as SQL);
    expect(rendered.sql).toContain("org_id");
    expect(rendered.params).toContain(OWNER_ORG);
    // Reading by user alone would match the same person's rows in every org.
    expect(rendered.params).not.toContain(ATTACKER_ORG);
    // The tenant scope the read runs under is named for the caller, not inherited.
    expect(mockTenantScopes).toEqual([OWNER_ORG]);
  });

  it("DENY: a different organization produces a different predicate", async () => {
    const owner = harness();
    await owner.service.sendToUser(OWNER_ORG, USER, { url: "/notifications" });
    const attacker = harness();
    await attacker.service.sendToUser(ATTACKER_ORG, USER, { url: "/notifications" });

    const ownerSql = dialect.sqlToQuery(owner.whereClauses[0] as SQL);
    const attackerSql = dialect.sqlToQuery(attacker.whereClauses[0] as SQL);
    expect(ownerSql.params).toContain(OWNER_ORG);
    expect(attackerSql.params).toContain(ATTACKER_ORG);
    expect(attackerSql.params).not.toContain(OWNER_ORG);
  });

  it("CONTROL: a membership-scoped send still binds the organization", async () => {
    const { service, whereClauses } = harness();

    await service.sendToUser(OWNER_ORG, USER, { url: "/notifications" }, undefined, 77);

    const rendered = dialect.sqlToQuery(whereClauses[0] as SQL);
    expect(rendered.sql).toContain("org_id");
    expect(rendered.params).toContain(OWNER_ORG);
    expect(rendered.params).toContain(77);
  });

  it("CONTROL: no subscriptions means no delete and no send", async () => {
    const { service, db } = harness([]);

    await service.sendToUser(OWNER_ORG, USER, { url: "/notifications" });

    expect(db.delete).not.toHaveBeenCalled();
  });

  it("channel fan-out scopes the member lookup to the organization", async () => {
    const members: Array<{ userId: string }> = [];
    const whereClauses: SQL[] = [];
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          innerJoin: jest.fn(() => ({
            where: jest.fn((clause: SQL) => {
              whereClauses.push(clause);
              return Promise.resolve(members);
            }),
          })),
        })),
      })),
    };
    const service = new WebPushService(
      db as unknown as Db,
      config,
      { execute: jest.fn() } as unknown as ExternalEffectLedger,
    );

    await service.sendToChannelMembers(OWNER_ORG, 42, "sender-user", { category: "CHAT" });

    const rendered = dialect.sqlToQuery(whereClauses[0] as SQL);
    expect(rendered.params).toContain(OWNER_ORG);
    expect(rendered.params).not.toContain(ATTACKER_ORG);
  });
});
