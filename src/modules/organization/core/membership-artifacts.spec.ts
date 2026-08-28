import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../../db/schema";
import {
  MEMBERSHIP_ARTIFACTS,
  MEMBERSHIP_ARTIFACT_IDS,
  MEMBERSHIP_ARTIFACT_TABLES,
  artifactsRequiringWriteOnRemoval,
  artifactsRequiringWriteOnSuspension,
} from "./membership-artifacts";

const MEMBERSHIP_COLUMN = /(^|_)membership_id$/;

const ATTRIBUTION_COLUMN =
  /(_by_membership_id$|^actor_membership_id$|^accepted_membership_id$|^inviter_membership_id$)/;

const PORTAL_COLUMN = /portal_membership_id$/;

const NOT_AN_ORG_MEMBERSHIP_GRANT: ReadonlyMap<string, string> = new Map([
  [
    "organizations.owner_membership_id",
    "the organization's own pointer at its owner, not a grant held by a membership",
  ],
]);

interface DiscoveredTable {
  table: string;
  columns: string[];
}

function discoverMembershipKeyedTables(): DiscoveredTable[] {
  const found: DiscoveredTable[] = [];
  for (const exported of Object.values(schema)) {
    if (!(exported instanceof PgTable)) continue;
    const config = getTableConfig(exported);
    const columns = config.columns
      .map((column) => column.name)
      .filter((name) => MEMBERSHIP_COLUMN.test(name))
      .filter((name) => !ATTRIBUTION_COLUMN.test(name))
      .filter((name) => !PORTAL_COLUMN.test(name))
      .filter(
        (name) => !NOT_AN_ORG_MEMBERSHIP_GRANT.has(`${config.name}.${name}`),
      );
    if (columns.length > 0) found.push({ table: config.name, columns });
  }
  return found;
}

describe("the membership artifact inventory is derived from the schema", () => {
  const discovered = discoverMembershipKeyedTables();

  it("finds membership-keyed tables at all — a scan that finds none is broken, not clean", () => {
    expect(discovered.length).toBeGreaterThan(3);
  });

  it("separates an authority column from an audit-attribution one", () => {
    expect(ATTRIBUTION_COLUMN.test("granted_by_membership_id")).toBe(true);
    expect(ATTRIBUTION_COLUMN.test("actor_membership_id")).toBe(true);
    expect(ATTRIBUTION_COLUMN.test("inviter_membership_id")).toBe(true);
    expect(ATTRIBUTION_COLUMN.test("organization_membership_id")).toBe(false);
    expect(ATTRIBUTION_COLUMN.test("delegatee_membership_id")).toBe(false);
    expect(ATTRIBUTION_COLUMN.test("issuer_membership_id")).toBe(false);
    expect(ATTRIBUTION_COLUMN.test("owner_membership_id")).toBe(false);
  });

  it("names every membership-keyed table in the inventory", () => {
    const inventoried = new Set<string>(MEMBERSHIP_ARTIFACT_TABLES);
    const missing = discovered
      .map((entry) => entry.table)
      .filter((table) => !inventoried.has(table));

    expect(missing).toEqual([]);
  });

  it("does not inventory a table that no longer exists in the schema", () => {
    const realTables = new Set<string>();
    for (const exported of Object.values(schema)) {
      if (!(exported instanceof PgTable)) continue;
      realTables.add(getTableConfig(exported).name);
    }
    const phantom = MEMBERSHIP_ARTIFACT_TABLES.filter(
      (table) => table !== null && !realTables.has(table),
    );

    expect(phantom).toEqual([]);
  });
});

describe("the membership artifact inventory is well formed", () => {
  it("has a unique id per artifact", () => {
    expect(new Set(MEMBERSHIP_ARTIFACT_IDS).size).toBe(
      MEMBERSHIP_ARTIFACT_IDS.length,
    );
  });

  it("records why every artifact is handled the way it is", () => {
    for (const artifact of MEMBERSHIP_ARTIFACTS) {
      expect(artifact.reason.trim().length).toBeGreaterThan(0);
      expect(artifact.keyedBy.trim().length).toBeGreaterThan(0);
    }
  });

  it("gives every non-table artifact a mechanism that is not a database one", () => {
    for (const artifact of MEMBERSHIP_ARTIFACTS) {
      if (artifact.table !== null) continue;
      expect(["session-store", "realtime", "provider", "cache"]).toContain(
        artifact.mechanism,
      );
    }
  });

  it("never claims a cascade for an artifact the database cannot cascade", () => {
    for (const artifact of MEMBERSHIP_ARTIFACTS) {
      if (artifact.onRemoval !== "cascade") continue;
      expect(artifact.table).not.toBeNull();
      expect(artifact.mechanism).not.toBe("realtime");
      expect(artifact.mechanism).not.toBe("provider");
      expect(artifact.mechanism).not.toBe("cache");
      expect(artifact.mechanism).not.toBe("session-store");
    }
  });

  it("revokes every credential and out-of-band capability on suspension", () => {
    const mustRevokeOnSuspension = [
      "agent_tokens",
      "user_delegations",
      "user_sessions",
      "realtime_capability",
      "user_integration_connections",
      "access_caches",
    ];
    const revoked = new Set(
      artifactsRequiringWriteOnSuspension().map((artifact) => artifact.id),
    );

    for (const id of mustRevokeOnSuspension) expect(revoked.has(id)).toBe(true);
  });

  it("lists the artifacts a removal path cannot leave to the database", () => {
    const ids = artifactsRequiringWriteOnRemoval().map((a) => a.id);

    expect(ids).toContain("resource_grants");
    expect(ids).toContain("kb_space_grants");
    expect(ids).toContain("realtime_capability");
    expect(ids).toContain("user_integration_connections");
    expect(ids).toContain("invitations");
    expect(ids).not.toContain("role_assignments");
  });
});
