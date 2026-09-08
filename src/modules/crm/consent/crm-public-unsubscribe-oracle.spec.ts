jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
}));

jest.mock("../../party/party-legacy-seam", () => ({
  ...jest.requireActual("../../party/party-legacy-seam"),
  resolveLegacyParty: jest.fn(),
}));

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Request } from "express";
import request from "supertest";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { logger } from "../../../common/logger/logger.service";
import { RateLimitService } from "../../../common/ratelimit/rate-limit.service";
import { ZodValidationInterceptor } from "../../../common/validation/zod-validation.interceptor";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { PermissionGuard } from "../../access/permission.guard";
import {
  resolveLegacyParty,
  type LegacyPartyRef,
  type LegacyPartyResolution,
} from "../../party/party-legacy-seam";
import {
  CrmConsentController,
  CrmPublicConsentController,
} from "./crm-consent.controller";
import { CrmConsentService } from "./crm-consent.service";
import { buildUnsubscribeToken } from "./unsubscribe-token.util";

const OWNER_ORG = "org-owner";
const OTHER_ORG = "org-attacker";

const LIVE_CONTACT = 1;
const DELETED_CONTACT = 2;
const ABSENT_CONTACT = 9999;
/** Live, but owned by OTHER_ORG — the cross-tenant probe. */
const FOREIGN_CONTACT = 7;

/** Stands in for `contact_party_map` ⋈ `business_parties`, keyed on (org, contact). */
const CONTACTS = new Map<string, Date | null>([
  [`${OWNER_ORG}:${LIVE_CONTACT}`, null],
  [`${OWNER_ORG}:${DELETED_CONTACT}`, new Date("2026-01-01T00:00:00Z")],
  [`${OTHER_ORG}:${FOREIGN_CONTACT}`, null],
]);

const seam = resolveLegacyParty as jest.MockedFunction<typeof resolveLegacyParty>;

function fakeSeam(
  _db: unknown,
  orgId: string,
  ref: LegacyPartyRef,
): Promise<LegacyPartyResolution> {
  if (ref.kind !== "CONTACT") return Promise.resolve({ status: "unresolved", ref });
  const key = `${orgId}:${ref.legacyId}`;
  const deletedAt = CONTACTS.get(key);
  if (deletedAt === undefined) return Promise.resolve({ status: "unresolved", ref });
  return Promise.resolve({
    status: "resolved",
    party: {
      partyId: `party-${ref.legacyId}`,
      organizationId: orgId,
      name: "Ada",
      partyType: "CUSTOMER",
      status: "active",
      deletedAt,
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

let insertThrows: Error | null = null;
const insert = jest.fn(() => {
  if (insertThrows) throw insertThrows;
  return {
    values: jest.fn().mockReturnValue({
      onConflictDoUpdate: jest.fn().mockReturnValue(thenableResolve([])),
      ...thenableResolve([]),
    }),
  };
});

const db = {
  select: jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
    }),
  }),
  insert,
} as unknown as Db;

const TEST_USER: CurrentUserContext = {
  userId: "user-1",
  orgId: OWNER_ORG,
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

class StubAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: CurrentUserContext }>();
    req.user = TEST_USER;
    return true;
  }
}

/**
 * The public unsubscribe endpoint promises one response for every caller. The
 * BOLA hardening in `2f9fd242c` made `record` throw 404 for an absent,
 * soft-deleted or foreign contact — correct for the authenticated routes, and on
 * the anonymous route it turned the status code into an existence oracle over
 * contacts. These tests pin BOTH halves: uniform on the public surface, 404 kept
 * on the authenticated one.
 */
describe("POST /crm/consent/unsubscribe — no existence oracle", () => {
  const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;
  let app: INestApplication;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = "u".repeat(64);

    const ref = await Test.createTestingModule({
      controllers: [CrmPublicConsentController, CrmConsentController],
      providers: [
        CrmConsentService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: { logCritical: jest.fn().mockResolvedValue(undefined) } },
        { provide: RateLimitService, useValue: { check: jest.fn().mockResolvedValue({ allowed: true }) } },
        { provide: APP_INTERCEPTOR, useClass: ZodValidationInterceptor },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(StubAuthGuard)
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = ref.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
  });

  beforeEach(() => {
    insertThrows = null;
    insert.mockClear();
    seam.mockReset();
    seam.mockImplementation(fakeSeam);
  });

  function unsubscribe(orgId: string, contactId: number) {
    return request(app.getHttpServer())
      .post("/crm/consent/unsubscribe")
      .send({ token: buildUnsubscribeToken({ orgId, contactId, channel: "EMAIL" }) });
  }

  it("answers 200 { success: true } for a live contact, and records the opt-out", async () => {
    const res = await unsubscribe(OWNER_ORG, LIVE_CONTACT);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(insert).toHaveBeenCalled();
  });

  it("answers the same 200 { success: true } for an id that does not exist", async () => {
    const res = await unsubscribe(OWNER_ORG, ABSENT_CONTACT);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(insert).not.toHaveBeenCalled();
  });

  it("answers the same 200 { success: true } for a soft-deleted contact", async () => {
    const res = await unsubscribe(OWNER_ORG, DELETED_CONTACT);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(insert).not.toHaveBeenCalled();
  });

  it("answers the same 200 { success: true } for another tenant's contact", async () => {
    // Contact 7 is live, but it belongs to OTHER_ORG, so resolving it under
    // OWNER_ORG is a cross-tenant miss — indistinguishable from a live hit.
    const res = await unsubscribe(OWNER_ORG, FOREIGN_CONTACT);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(insert).not.toHaveBeenCalled();
  });

  it("answers the same 200 { success: true } for a token that does not verify", async () => {
    const res = await request(app.getHttpServer())
      .post("/crm/consent/unsubscribe")
      .send({ token: "u1.notarealbody.notarealsignature" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(insert).not.toHaveBeenCalled();
  });

  it("returns one indistinguishable response across hit, absent, deleted, foreign and unverifiable", async () => {
    const observed: Array<{ status: number; body: unknown }> = [];
    for (const [orgId, contactId] of [
      [OWNER_ORG, LIVE_CONTACT],
      [OWNER_ORG, ABSENT_CONTACT],
      [OWNER_ORG, DELETED_CONTACT],
      [OWNER_ORG, FOREIGN_CONTACT],
    ] as const) {
      const res = await unsubscribe(orgId, contactId);
      observed.push({ status: res.status, body: res.body });
    }
    const forged = await request(app.getHttpServer())
      .post("/crm/consent/unsubscribe")
      .send({ token: "u1.notarealbody.notarealsignature" });
    observed.push({ status: forged.status, body: forged.body });

    const distinct = new Set(observed.map((o) => JSON.stringify(o)));
    expect(distinct.size).toBe(1);
    expect(observed[0]).toEqual({ status: 200, body: { success: true } });
  });

  it("logs the absorbed miss server-side with org, contact and channel", async () => {
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      await unsubscribe(OWNER_ORG, ABSENT_CONTACT);
      expect(warn).toHaveBeenCalledWith(
        "crm.consent.unsubscribe.unresolved",
        expect.objectContaining({
          orgId: OWNER_ORG,
          contactId: ABSENT_CONTACT,
          channel: "EMAIL",
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does NOT report a database failure as a successful unsubscribe", async () => {
    insertThrows = new Error("write failed: connection terminated unexpectedly");
    const res = await unsubscribe(OWNER_ORG, LIVE_CONTACT);
    expect(res.status).not.toBe(200);
    expect(res.body).not.toEqual({ success: true });
  });
});

describe("POST /crm/consent/contacts/:contactId — the authenticated route keeps its 404", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      controllers: [CrmConsentController],
      providers: [
        CrmConsentService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: { logCritical: jest.fn().mockResolvedValue(undefined) } },
        { provide: APP_INTERCEPTOR, useClass: ZodValidationInterceptor },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(StubAuthGuard)
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = ref.createNestApplication();
    await app.init();
  });

  afterAll(async () => app?.close());

  beforeEach(() => {
    insertThrows = null;
    insert.mockClear();
    seam.mockReset();
    seam.mockImplementation(fakeSeam);
  });

  function record(contactId: number) {
    return request(app.getHttpServer())
      .post(`/crm/consent/contacts/${contactId}`)
      .send({ channel: "EMAIL", status: "OPTED_OUT", source: "USER_ENTRY" });
  }

  it("records for the caller's own live contact", async () => {
    const res = await record(LIVE_CONTACT);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it("still 404s an id that does not exist", async () => {
    expect((await record(ABSENT_CONTACT)).status).toBe(404);
  });

  it("still 404s a soft-deleted contact", async () => {
    expect((await record(DELETED_CONTACT)).status).toBe(404);
  });

  it("still 404s a contact belonging to another tenant", async () => {
    // TEST_USER is in OWNER_ORG; contact 7 is live under OTHER_ORG.
    expect((await record(FOREIGN_CONTACT)).status).toBe(404);
  });
});
