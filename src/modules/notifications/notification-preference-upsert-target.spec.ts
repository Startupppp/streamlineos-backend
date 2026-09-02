import { ForbiddenException } from "@nestjs/common";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { notificationPreferences, notificationSuppressionRules } from "../../db/schema";
import { NotificationPreferencesService } from "./notification-preferences.service";

/**
 * `ON CONFLICT (<cols>)` is resolved by Postgres against a real unique index; naming
 * columns that carry no unique raises 42P10 and fails the whole statement, so an upsert
 * target that has drifted from the schema breaks every write on the route.
 */
const dialect = new PgDialect();

interface Captured {
  headerTarget: unknown;
  headerInserts: number;
  deleteClauses: SQL[];
}

function harness() {
  const captured: Captured = { headerTarget: undefined, headerInserts: 0, deleteClauses: [] };
  const db = {
    insert: jest.fn(() => ({
      values: jest.fn((v: unknown) => {
        const rows = Array.isArray(v) ? v : [v];
        if (rows[0] && "scopeType" in (rows[0] as object))
          return { onConflictDoUpdate: jest.fn().mockResolvedValue(undefined) };
        captured.headerInserts += 1;
        return {
          onConflictDoUpdate: jest.fn((config: { target: unknown }) => {
            captured.headerTarget = config.target;
            return { returning: jest.fn().mockResolvedValue([{ id: 1 }]) };
          }),
        };
      }),
    })),
    delete: jest.fn(() => ({
      where: jest.fn((clause: SQL) => {
        captured.deleteClauses.push(clause);
        return Promise.resolve();
      }),
    })),
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn().mockResolvedValue([{ id: 42 }]),
      })),
    })),
    query: {
      notificationPreferences: { findFirst: jest.fn().mockResolvedValue(undefined) },
      notificationPolicyDefaults: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
  };
  const svc = new NotificationPreferencesService(
    db as unknown as ConstructorParameters<typeof NotificationPreferencesService>[0],
    { assertKnown: jest.fn(), listForOrg: jest.fn() } as unknown as ConstructorParameters<
      typeof NotificationPreferencesService
    >[1],
  );
  return { svc, captured, db };
}

const ORG = "org-a";
const USER = "user-1";
const MEMBERSHIP = 7;

describe("notification_preferences upsert target", () => {
  it("declares exactly one unique index the upsert can target, on (org_id, membership_id)", () => {
    const config = getTableConfig(notificationPreferences);
    const uniqueColumnSets = [
      ...config.indexes.filter((i) => i.config.unique).map((i) => i.config.columns),
      ...config.uniqueConstraints.map((c) => c.columns),
    ].map((columns) =>
      columns
        .map((column) => ("name" in column ? String(column.name) : ""))
        .sort()
        .join(","),
    );

    expect(uniqueColumnSets).toContain("membership_id,org_id");
    // A bare unique on user_id was dropped in 0415: it made one row serve a user
    // across every org. Targeting it again would resurrect that bug.
    expect(uniqueColumnSets).not.toContain("user_id");
    expect(uniqueColumnSets).not.toContain("org_id,user_id");
  });

  it("targets the (org_id, membership_id) columns, not user_id", async () => {
    const { svc, captured } = harness();

    await svc.update(ORG, USER, { soundEnabled: false }, MEMBERSHIP);

    expect(Array.isArray(captured.headerTarget)).toBe(true);
    expect(captured.headerTarget).toEqual([
      notificationPreferences.orgId,
      notificationPreferences.membershipId,
    ]);
    expect(captured.headerTarget).not.toContain(notificationPreferences.userId);
  });

  it("refuses the write before it runs when the caller has no membership", async () => {
    const { svc, captured } = harness();

    await expect(svc.update(ORG, USER, { soundEnabled: false }, null)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // A row written with a NULL membership_id is invisible to the unique index, so it
    // would be inserted again on every save and never read back.
    expect(captured.headerInserts).toBe(0);
  });

  it("refuses an event-preference write with no membership", async () => {
    const { svc, captured } = harness();

    await expect(
      svc.updateEventPreference(ORG, USER, "build.ticket.assigned", { muted: true }, null),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(captured.headerInserts).toBe(0);
  });
});

describe("removeSuppression ownership", () => {
  it("carries org and user into the delete, not the id alone", async () => {
    const { svc, captured } = harness();

    await svc.removeSuppression(ORG, USER, 42);

    const suppressionDeletes = captured.deleteClauses.map((clause) => dialect.sqlToQuery(clause));
    const target = suppressionDeletes.find((q) => q.sql.includes("id"));
    expect(target).toBeDefined();
    const columns = getTableConfig(notificationSuppressionRules).columns.map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["org_id", "user_id"]));
    expect(target?.sql).toContain("org_id");
    expect(target?.sql).toContain("user_id");
    expect(target?.params).toEqual(expect.arrayContaining([42, ORG, USER]));
  });
});
