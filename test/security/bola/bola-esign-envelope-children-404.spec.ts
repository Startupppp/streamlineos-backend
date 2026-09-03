/**
 * BOLA regression for the three e-sign envelope-child list routes (register A-3).
 *
 *   GET /sign/envelopes/:envelopeId/fields
 *   GET /sign/envelopes/:envelopeId/recipients
 *   GET /sign/envelopes/:envelopeId/documents
 *
 * Each was a bare `findMany` on `(orgId, envelopeId)`. For another organisation's
 * envelope id the predicate matched nothing, so the route answered `[]` with HTTP
 * 200. No row crossed the tenant boundary — but the response still separated
 * "this envelope exists and has no fields" from "this envelope is not yours",
 * which is exactly the disclosure the 404 contract exists to prevent. The fourth
 * route named in the original finding, `.../audit`, was already fixed and calls
 * `mustGetVisibleEnvelope`; these three did not.
 *
 * After the fix all three resolve the envelope in the caller's org and scope
 * first, so a cross-tenant id and an id belonging to no organisation answer the
 * SAME 404 — never 403, never an empty 200.
 */

import { NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import type { Db } from "../../../src/db/drizzle.module";
import type { CurrentUserContext } from "../../../src/common/auth/backend-claims";
import type { AccessService } from "../../../src/modules/access/access.service";
import { SignFieldsService } from "../../../src/modules/e-sign/sign-fields.service";
import { SignFieldsController } from "../../../src/modules/e-sign/sign-fields.controller";
import { SignRecipientsService } from "../../../src/modules/e-sign/sign-recipients.service";
import { SignRecipientsController } from "../../../src/modules/e-sign/sign-recipients.controller";
import { SignDocumentsService } from "../../../src/modules/e-sign/sign-documents.service";
import { SignDocumentsController } from "../../../src/modules/e-sign/sign-documents.controller";
import { SYSTEM_ENVELOPE_SCOPE } from "../../../src/modules/e-sign/sign-envelope-scope";

const CALLER_ORG = "org-caller";
const SENDER_MEMBERSHIP = 10;
const OTHER_MEMBERSHIP = 20;

/** The envelope the caller does own, used as the same-tenant control. */
const OWN_ENVELOPE_ID = 42;
/** An envelope id that exists, but in another organisation. */
const CROSS_TENANT_ENVELOPE_ID = 777;
/** An envelope id that exists in no organisation at all. */
const ABSENT_ENVELOPE_ID = 999999;

const ownEnvelope = {
  id: OWN_ENVELOPE_ID,
  orgId: CALLER_ORG,
  senderMembershipId: SENDER_MEMBERSHIP,
  title: "Own envelope",
  status: "sent",
  routingMode: "parallel",
};

const CHILD_ROWS = [{ id: 1, orgId: CALLER_ORG, envelopeId: OWN_ENVELOPE_ID }];

type ChildTable = "signFields" | "signRecipients" | "signDocuments";

interface Harness {
  db: Db;
  /** The child-table read. It must never run for an envelope the caller cannot see. */
  childFindMany: jest.Mock;
  envelopeFindFirst: jest.Mock;
}

/**
 * `signEnvelopes.findFirst` stands in for the org-scoped predicate the services
 * issue: it answers with a row only for an envelope in the caller's own org, so a
 * cross-tenant id and an absent id both arrive as `undefined`, exactly as they do
 * against Postgres.
 */
function makeHarness(child: ChildTable): Harness {
  const envelopeFindFirst = jest.fn().mockResolvedValue(undefined);
  const childFindMany = jest.fn().mockResolvedValue(CHILD_ROWS);
  const db = {
    query: {
      signEnvelopes: { findFirst: envelopeFindFirst },
      [child]: { findMany: childFindMany },
    },
  } as unknown as Db;
  return { db, childFindMany, envelopeFindFirst };
}

/** Resolves the envelope only when the requested id is the caller's own. */
function seedEnvelopeLookup(h: Harness, visibleId: number): void {
  h.envelopeFindFirst.mockImplementation(() =>
    Promise.resolve(visibleId === OWN_ENVELOPE_ID ? ownEnvelope : undefined),
  );
}

function makeFields(h: Harness): SignFieldsService {
  return new SignFieldsService(h.db, { record: jest.fn() } as never);
}

function makeRecipients(h: Harness): SignRecipientsService {
  return new SignRecipientsService(h.db, { record: jest.fn() } as never, {} as never);
}

function makeDocuments(h: Harness): SignDocumentsService {
  return new SignDocumentsService(h.db, {} as never, {} as never, {} as never, { record: jest.fn() } as never);
}

interface RouteUnderTest {
  label: string;
  child: ChildTable;
  call: (h: Harness, envelopeId: number) => Promise<unknown>;
  arity: number;
}

const ROUTES: RouteUnderTest[] = [
  {
    label: "GET /sign/envelopes/:envelopeId/fields",
    child: "signFields",
    call: (h, id) => makeFields(h).listForEnvelope(CALLER_ORG, id, SYSTEM_ENVELOPE_SCOPE),
    arity: 3,
  },
  {
    label: "GET /sign/envelopes/:envelopeId/recipients",
    child: "signRecipients",
    call: (h, id) => makeRecipients(h).listForEnvelope(CALLER_ORG, id, SYSTEM_ENVELOPE_SCOPE),
    arity: 3,
  },
  {
    label: "GET /sign/envelopes/:envelopeId/documents",
    child: "signDocuments",
    call: (h, id) => makeDocuments(h).list(CALLER_ORG, id, SYSTEM_ENVELOPE_SCOPE),
    arity: 3,
  },
];

describe.each(ROUTES)("$label — cross-tenant envelope id", (route) => {
  it("returns the child rows for an envelope the caller does own", async () => {
    const h = makeHarness(route.child);
    seedEnvelopeLookup(h, OWN_ENVELOPE_ID);
    await expect(route.call(h, OWN_ENVELOPE_ID)).resolves.toEqual(CHILD_ROWS);
    expect(h.childFindMany).toHaveBeenCalledTimes(1);
  });

  it("throws NotFoundException for another organization's envelope id, instead of an empty 200", async () => {
    const h = makeHarness(route.child);
    seedEnvelopeLookup(h, CROSS_TENANT_ENVELOPE_ID);
    await expect(route.call(h, CROSS_TENANT_ENVELOPE_ID)).rejects.toThrow(NotFoundException);
  });

  it("answers 404, never 403, so the refusal does not confirm the envelope exists", async () => {
    const h = makeHarness(route.child);
    seedEnvelopeLookup(h, CROSS_TENANT_ENVELOPE_ID);
    await expect(route.call(h, CROSS_TENANT_ENVELOPE_ID)).rejects.toMatchObject({ status: 404 });
  });

  it("never reads the child table for an envelope the caller cannot see", async () => {
    const h = makeHarness(route.child);
    seedEnvelopeLookup(h, CROSS_TENANT_ENVELOPE_ID);
    await expect(route.call(h, CROSS_TENANT_ENVELOPE_ID)).rejects.toThrow(NotFoundException);
    expect(h.childFindMany).not.toHaveBeenCalled();
  });

  it("answers a cross-tenant id and an absent id identically — the three-way control that separates a leak from a miss", async () => {
    const crossHarness = makeHarness(route.child);
    seedEnvelopeLookup(crossHarness, CROSS_TENANT_ENVELOPE_ID);
    const absentHarness = makeHarness(route.child);
    seedEnvelopeLookup(absentHarness, ABSENT_ENVELOPE_ID);

    const cross = await route.call(crossHarness, CROSS_TENANT_ENVELOPE_ID).catch((e: unknown) => e);
    const absent = await route.call(absentHarness, ABSENT_ENVELOPE_ID).catch((e: unknown) => e);

    expect(cross).toBeInstanceOf(NotFoundException);
    expect(absent).toBeInstanceOf(NotFoundException);
    expect((cross as NotFoundException).getResponse()).toEqual((absent as NotFoundException).getResponse());
  });

  it("throws NotFoundException for an in-org envelope the caller's sign:envelope:view scope excludes", async () => {
    const h = makeHarness(route.child);
    seedEnvelopeLookup(h, OWN_ENVELOPE_ID);
    const ownScope = { membershipId: OTHER_MEMBERSHIP, viewAll: false };
    const call =
      route.child === "signDocuments"
        ? makeDocuments(h).list(CALLER_ORG, OWN_ENVELOPE_ID, ownScope)
        : route.child === "signFields"
          ? makeFields(h).listForEnvelope(CALLER_ORG, OWN_ENVELOPE_ID, ownScope)
          : makeRecipients(h).listForEnvelope(CALLER_ORG, OWN_ENVELOPE_ID, ownScope);
    await expect(call).rejects.toThrow(NotFoundException);
    expect(h.childFindMany).not.toHaveBeenCalled();
  });

  it("requires a scope argument, so an unscoped list is unrepresentable rather than merely discouraged", () => {
    const h = makeHarness(route.child);
    const method =
      route.child === "signDocuments"
        ? makeDocuments(h).list
        : route.child === "signFields"
          ? makeFields(h).listForEnvelope
          : makeRecipients(h).listForEnvelope;
    expect(method.length).toBe(route.arity);
  });
});

describe("the child-list controllers resolve the caller's sign:envelope:view scope, not the route's own key", () => {
  const makeUser = (): CurrentUserContext =>
    ({
      orgId: CALLER_ORG,
      userId: "user-other",
      isOrgOwner: false,
      principal: { kind: "human-session", membershipId: OTHER_MEMBERSHIP, isOrgOwner: false },
    }) as unknown as CurrentUserContext;

  const makeAccess = (scope: "all" | "own" | "none"): AccessService =>
    ({ scopeFor: jest.fn().mockResolvedValue(scope) }) as unknown as AccessService;

  it("fields — forwards viewAll:true when sign:envelope:view resolves all", async () => {
    const service = { listForEnvelope: jest.fn().mockResolvedValue([]) } as unknown as SignFieldsService;
    const access = makeAccess("all");
    await new SignFieldsController(service, access).list(OWN_ENVELOPE_ID, makeUser());
    expect(access.scopeFor).toHaveBeenCalledWith(expect.anything(), "sign:envelope:view");
    expect(service.listForEnvelope).toHaveBeenCalledWith(
      CALLER_ORG,
      OWN_ENVELOPE_ID,
      expect.objectContaining({ viewAll: true, membershipId: OTHER_MEMBERSHIP }),
    );
  });

  it("recipients — forwards viewAll:false when sign:envelope:view resolves own", async () => {
    const service = { listForEnvelope: jest.fn().mockResolvedValue([]) } as unknown as SignRecipientsService;
    const access = makeAccess("own");
    await new SignRecipientsController(service, access).list(OWN_ENVELOPE_ID, makeUser());
    expect(access.scopeFor).toHaveBeenCalledWith(expect.anything(), "sign:envelope:view");
    expect(service.listForEnvelope).toHaveBeenCalledWith(
      CALLER_ORG,
      OWN_ENVELOPE_ID,
      expect.objectContaining({ viewAll: false, membershipId: OTHER_MEMBERSHIP }),
    );
  });

  /**
   * `sign:documents:view` is NOT scopable, so gating this route on its own key
   * would resolve "all" for everyone who holds it — the exact no-op the
   * constitution names. It binds to `sign:envelope:view` instead.
   */
  it("documents — resolves the scopable envelope key rather than its own non-scopable sign:documents:view", async () => {
    const service = { list: jest.fn().mockResolvedValue([]) } as unknown as SignDocumentsService;
    const access = makeAccess("own");
    await new SignDocumentsController(service, access).list(OWN_ENVELOPE_ID, makeUser());
    expect(access.scopeFor).toHaveBeenCalledWith(expect.anything(), "sign:envelope:view");
    expect(access.scopeFor).not.toHaveBeenCalledWith(expect.anything(), "sign:documents:view");
    expect(service.list).toHaveBeenCalledWith(
      CALLER_ORG,
      OWN_ENVELOPE_ID,
      expect.objectContaining({ viewAll: false }),
    );
  });
});

describe("the internal callers of these lists name their own scope", () => {
  it("SYSTEM_ENVELOPE_SCOPE is the only unrestricted scope, and it is frozen", () => {
    expect(SYSTEM_ENVELOPE_SCOPE).toEqual({ membershipId: null, viewAll: true });
    expect(Object.isFrozen(SYSTEM_ENVELOPE_SCOPE)).toBe(true);
  });

  it("fetchBuffers reads documents under SYSTEM_ENVELOPE_SCOPE rather than an unscoped read", async () => {
    const h = makeHarness("signDocuments");
    seedEnvelopeLookup(h, OWN_ENVELOPE_ID);
    const service = makeDocuments(h);
    const listSpy = jest.spyOn(service, "list").mockResolvedValue([]);
    await service.fetchBuffers(CALLER_ORG, OWN_ENVELOPE_ID);
    expect(listSpy).toHaveBeenCalledWith(CALLER_ORG, OWN_ENVELOPE_ID, SYSTEM_ENVELOPE_SCOPE);
  });
});

/**
 * Guards the claim in register A-3 that `.../audit` was already fixed, so a
 * future reader does not re-open a defect that no longer exists — and so that a
 * regression there fails here rather than silently rejoining the NO-404 set.
 */
describe("GET /sign/envelopes/:envelopeId/audit — already bound, asserted so it stays bound", () => {
  it("routes its envelope lookup through the same helper the three fixed routes now use", async () => {
    const { SignAuditService } = await import("../../../src/modules/e-sign/sign-audit.service");
    const envelopeFindFirst = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: { signEnvelopes: { findFirst: envelopeFindFirst } },
      select: jest.fn(),
    } as unknown as Db;
    const service = new SignAuditService(db);
    await expect(
      service.listForEnvelope(CALLER_ORG, CROSS_TENANT_ENVELOPE_ID, SYSTEM_ENVELOPE_SCOPE),
    ).rejects.toThrow(NotFoundException);
    expect(db.select).not.toHaveBeenCalled();
  });
});

/**
 * Found while closing the three above, and the same class of defect: the preview
 * URL is the envelope's own source PDF, and `sign:documents:view` is NOT scopable,
 * so every holder resolved "all" and could preview any document of any envelope in
 * the organization — including envelopes their `sign:envelope:view` scope withheld.
 * This is the shape the certificate/final-pdf fix (register #15) already closed.
 */
describe("GET /sign/documents/:documentId/preview — bound to the envelope's view scope", () => {
  const DOCUMENT_ID = 7;
  const makePreviewService = (doc: unknown, envelope: unknown) => {
    const storage = { getFileUrl: jest.fn().mockResolvedValue("https://signed.example/7") };
    const db = {
      query: {
        signDocuments: { findFirst: jest.fn().mockResolvedValue(doc) },
        signEnvelopes: { findFirst: jest.fn().mockResolvedValue(envelope) },
      },
    } as unknown as Db;
    const service = new SignDocumentsService(db, storage as never, {} as never, {} as never, { record: jest.fn() } as never);
    return { service, storage };
  };
  const doc = { id: DOCUMENT_ID, orgId: CALLER_ORG, envelopeId: OWN_ENVELOPE_ID, currentFileKey: "k" };

  it("returns the signed url when the caller's sign:envelope:view scope admits the envelope", async () => {
    const { service } = makePreviewService(doc, ownEnvelope);
    const result = await service.getPreviewUrl(CALLER_ORG, DOCUMENT_ID, SYSTEM_ENVELOPE_SCOPE);
    expect(result.url).toBe("https://signed.example/7");
  });

  it("throws NotFoundException, and mints no url, for a document whose envelope the scope withholds", async () => {
    const { service, storage } = makePreviewService(doc, ownEnvelope);
    await expect(
      service.getPreviewUrl(CALLER_ORG, DOCUMENT_ID, { membershipId: OTHER_MEMBERSHIP, viewAll: false }),
    ).rejects.toThrow(NotFoundException);
    expect(storage.getFileUrl).not.toHaveBeenCalled();
  });

  it("answers the same 404 body a missing document answers, so it is not an existence oracle", async () => {
    const withheld = makePreviewService(doc, ownEnvelope);
    const missing = makePreviewService(undefined, undefined);
    const a = await withheld.service
      .getPreviewUrl(CALLER_ORG, DOCUMENT_ID, { membershipId: OTHER_MEMBERSHIP, viewAll: false })
      .catch((e: unknown) => e);
    const b = await missing.service
      .getPreviewUrl(CALLER_ORG, DOCUMENT_ID, SYSTEM_ENVELOPE_SCOPE)
      .catch((e: unknown) => e);
    expect((a as NotFoundException).getResponse()).toEqual((b as NotFoundException).getResponse());
  });

  it("requires a scope argument", () => {
    expect(SignDocumentsService.prototype.getPreviewUrl.length).toBe(3);
  });
});

/** The bare-findMany shape must not come back in this module. */
describe("no envelope-child list in e-sign reads its table before the envelope", () => {
  const SOURCES = [
    "src/modules/e-sign/sign-fields.service.ts",
    "src/modules/e-sign/sign-recipients.service.ts",
    "src/modules/e-sign/sign-documents.service.ts",
  ];

  it.each(SOURCES)("%s asserts envelope visibility inside its envelope-scoped list", async (relPath) => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const source = await readFile(join(__dirname, "../../..", relPath), "utf8");
    expect(source).toContain("mustGetVisibleEnvelope");
    const listBody = source.slice(source.indexOf("envelopeId: number, scope: EnvelopeViewScope"));
    expect(listBody.indexOf("mustGetVisibleEnvelope")).toBeGreaterThan(-1);
    expect(listBody.indexOf("mustGetVisibleEnvelope")).toBeLessThan(listBody.indexOf("findMany"));
  });
});
