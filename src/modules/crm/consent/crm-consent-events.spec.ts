import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Param, SQL, getTableColumns } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import type { AuditService } from "../../../common/audit/audit.service";
import { crmContactConsentEvents } from "../../../db/schema";
import { CrmConsentService } from "./crm-consent.service";
import { CrmConsentController } from "./crm-consent.controller";
import { consentEventsQuerySchema } from "./dto/consent.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

interface Captured {
  projection: Record<string, unknown> | undefined;
  where: unknown;
  orderBy: unknown[];
  limit: number | undefined;
}

function makeDb(rows: unknown[]) {
  const captured: Captured = {
    projection: undefined,
    where: undefined,
    orderBy: [],
    limit: undefined,
  };
  const chain = {
    from: jest.fn().mockImplementation(() => chain),
    leftJoin: jest.fn().mockImplementation(() => chain),
    where: jest.fn().mockImplementation((w: unknown) => {
      captured.where = w;
      return chain;
    }),
    orderBy: jest.fn().mockImplementation((...args: unknown[]) => {
      captured.orderBy = args;
      return chain;
    }),
    limit: jest.fn().mockImplementation((n: number) => {
      captured.limit = n;
      return Promise.resolve(rows);
    }),
  };
  const db = {
    select: jest.fn().mockImplementation((projection?: Record<string, unknown>) => {
      captured.projection = projection;
      return chain;
    }),
  } as unknown as Db;
  return { db, captured };
}

function boundValues(node: unknown, seen = new Set<unknown>()): unknown[] {
  if (node instanceof Param) return [node.value];
  if (!(node instanceof SQL) || seen.has(node)) return [];
  seen.add(node);
  return node.queryChunks.flatMap((chunk) => boundValues(chunk, seen));
}

const audit = {} as AuditService;
const user = { orgId: "org-1", userId: "user-1" } as CurrentUserContext;

describe("consent evidence trail read", () => {
  it("projects the row instead of returning it whole", async () => {
    const { db, captured } = makeDb([]);
    await new CrmConsentService(db, audit).listConsentEvents("org-1", 7, 20);

    /*
      Backend §1: services return minimal DTOs, never raw ORM rows. A bare
      `select()` here would hand the caller `org_id` and `contact_party_id` --
      the tenant key and an internal id that exists only because ticket 08's
      expand has not contracted yet.
    */
    expect(captured.projection).toBeDefined();
    const projected = Object.keys(captured.projection ?? {});
    expect(projected).not.toContain("orgId");
    expect(projected).not.toContain("contactPartyId");

    /*
      And the inverse, which is the half a projection test usually forgets: every
      OTHER column must be present. Without this, adding a column to the table
      and forgetting the projection is invisible -- the endpoint silently stops
      returning it and the test above still passes.
    */
    const expected = [
      ...Object.keys(getTableColumns(crmContactConsentEvents)).filter(
        (c) => c !== "orgId" && c !== "contactPartyId",
      ),
      /* Joined, not stored: the actor's name, because a screen may never render a raw id. */
      "recordedByName",
    ];
    expect(projected.sort()).toEqual(expected.sort());
  });

  it("orders newest first and breaks the tie, so the history cannot reorder itself", async () => {
    const { db, captured } = makeDb([]);
    await new CrmConsentService(db, audit).listConsentEvents("org-1", 7, 20);

    /*
      Two arguments, not one. `created_at` alone leaves same-millisecond rows --
      an import touching several channels writes exactly that -- free to swap
      between requests, which in an evidence trail reads as the record changing
      its story.
    */
    expect(captured.orderBy).toHaveLength(2);
  });

  it("threads the caller's limit rather than a constant", async () => {
    const { db, captured } = makeDb([]);
    await new CrmConsentService(db, audit).listConsentEvents("org-1", 7, 3);
    expect(captured.limit).toBe(3);
  });

  it("scopes to the org and the contact", async () => {
    const { db, captured } = makeDb([]);
    await new CrmConsentService(db, audit).listConsentEvents("org-9", 42, 20);

    /*
      Read the bound parameters out of the SQL tree rather than stringifying it.
      A drizzle predicate holds live column objects that point back at their
      table, so `JSON.stringify` throws on the cycle -- and a test that reaches
      for the rendered text is really asking whether the values were BOUND,
      which is what this walks for.
    */
    expect(boundValues(captured.where)).toEqual(expect.arrayContaining(["org-9", 42]));
  });
});

describe("the events route", () => {
  it("passes the query's limit through, so ?limit= is not decoration", async () => {
    const { db, captured } = makeDb([]);
    const service = new CrmConsentService(db, audit);
    const controller = new CrmConsentController(service);

    await controller.listEvents({ contactId: 7 }, { limit: 5 }, user);

    expect(captured.limit).toBe(5);
  });

  it("defaults the limit and refuses one past the 100/page cap", () => {
    expect(consentEventsQuerySchema.parse({}).limit).toBe(20);
    expect(consentEventsQuerySchema.parse({ limit: "50" }).limit).toBe(50);
    expect(() => consentEventsQuerySchema.parse({ limit: 101 })).toThrow();
    expect(() => consentEventsQuerySchema.parse({ limit: 0 })).toThrow();
  });

  it("is gated on the same read key as the rest of the consent surface", () => {
    const source = readFileSync(join(__dirname, "crm-consent.controller.ts"), "utf8");
    const handler = source.slice(source.indexOf('@Get("contacts/:contactId/events")'));
    expect(handler.slice(0, handler.indexOf("listEvents"))).toContain(
      '@RequirePermission("crm:contacts:view")',
    );
  });
});
