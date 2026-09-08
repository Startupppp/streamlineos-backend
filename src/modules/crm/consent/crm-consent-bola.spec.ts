jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>, _opts?: unknown) => fn(_db),
}));

jest.mock("../../party/party-legacy-seam", () => ({
  ...jest.requireActual("../../party/party-legacy-seam"),
  resolveLegacyParty: jest.fn(),
}));

import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import {
  resolveLegacyParty,
  type LegacyPartyRef,
  type LegacyPartyResolution,
} from "../../party/party-legacy-seam";
import { CrmConsentService } from "./crm-consent.service";

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

const LIVE_CONTACT = 1;
const DELETED_CONTACT = 2;

/**
 * The seam stands in for `contact_party_map` ⋈ `business_parties`.
 *
 * Keyed on (org, contact) because that is the map's primary key, so a contact
 * asked for under the wrong tenant resolves unresolved rather than resolving to
 * somebody else's party — the property the direct `contacts` read used to get
 * from its own `org_id` predicate. `deletedAt` comes back with the answer, which
 * is the party's and therefore the contact's: the only two writers of
 * `contacts.deleted_at` derive it from that column in the same statement.
 */
const CONTACTS = new Map<string, Date | null>([
  [`${OWNER_ORG}:${LIVE_CONTACT}`, null],
  [`${OWNER_ORG}:${DELETED_CONTACT}`, new Date("2026-01-01T00:00:00Z")],
]);

const seam = resolveLegacyParty as jest.MockedFunction<typeof resolveLegacyParty>;

function fakeSeam(_db: unknown, orgId: string, ref: LegacyPartyRef): Promise<LegacyPartyResolution> {
  if (ref.kind !== "CONTACT") return Promise.resolve({ status: "unresolved", ref });
  const key = `${orgId}:${ref.legacyId}`;
  if (!CONTACTS.has(key)) return Promise.resolve({ status: "unresolved", ref });
  return Promise.resolve({
    status: "resolved",
    party: {
      partyId: `party-${ref.legacyId}`,
      organizationId: orgId,
      name: "Ada",
      partyType: "CUSTOMER",
      status: "active",
      deletedAt: CONTACTS.get(key) ?? null,
      resolvedVia: "contact-map",
      followedMerge: false,
    },
  });
}

function thenableResolve<T>(value: T) {
  const p = Promise.resolve(value);
  return {
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    finally: p.finally.bind(p),
  };
}

function makeService() {
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockReturnValue(thenableResolve([])),
        ...thenableResolve([]),
      }),
    }),
  } as unknown as Db;
  const audit = { logCritical: jest.fn().mockResolvedValue(undefined) };
  const svc = new CrmConsentService(db, audit as never);
  return { svc, db };
}

const INPUT = {
  contactId: LIVE_CONTACT,
  channel: "EMAIL" as const,
  status: "OPTED_IN" as const,
  source: "USER_ENTRY" as const,
  recordedByUserId: "u1",
};

describe("CrmConsentService.record — cross-tenant isolation", () => {
  beforeEach(() => {
    seam.mockReset();
    seam.mockImplementation(fakeSeam);
  });

  it("records consent when contact belongs to the caller's org (own live contact)", async () => {
    const { svc, db } = makeService();
    await expect(svc.record(OWNER_ORG, INPUT)).resolves.toBeUndefined();
    expect(db.insert).toHaveBeenCalled();
  });

  it("throws 404 for a soft-deleted contact in the caller's own org", async () => {
    const { svc, db } = makeService();
    await expect(
      svc.record(OWNER_ORG, { ...INPUT, contactId: DELETED_CONTACT }),
    ).rejects.toThrow(NotFoundException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("throws 404 when contact belongs to a different org (cross-tenant)", async () => {
    const { svc, db } = makeService();
    await expect(svc.record(ATTACKER_ORG, INPUT)).rejects.toThrow(NotFoundException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("throws 404 when contact does not exist (unknown id)", async () => {
    const { svc } = makeService();
    await expect(svc.record(OWNER_ORG, { ...INPUT, contactId: 9999 })).rejects.toThrow(
      NotFoundException,
    );
  });

  it("resolves under the caller's org, never one supplied by the request", async () => {
    const { svc } = makeService();
    await svc.record(OWNER_ORG, INPUT);
    expect(seam).toHaveBeenCalledWith(expect.anything(), OWNER_ORG, {
      kind: "CONTACT",
      legacyId: LIVE_CONTACT,
    });
  });
});
