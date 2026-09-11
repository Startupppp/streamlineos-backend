/**
 * BOLA regression for `sign:certificate:download` (findings register #15).
 *
 * Neither `sign:certificate:download` nor `sign:audit:view` is scopable, so a
 * per-person `user_permission_grants` row hands either out at scope "all" while
 * the same member's `sign:envelope:view` stays "own". Before the fix,
 * `GET /sign/envelopes/:envelopeId/certificate`,
 * `GET /sign/envelopes/:envelopeId/final-pdf` and
 * `GET /sign/envelopes/:envelopeId/audit` bound only `orgId`, so that member
 * could download every fully-executed contract PDF in the organisation and read
 * the signing trail of every envelope in it — who opened, signed and downloaded
 * what, and when. Any other tenant's envelope id was the same request minus the
 * org match.
 *
 * After the fix all three routes resolve the caller's `sign:envelope:view` scope
 * and answer 404 (never 403) for an out-of-scope or cross-tenant envelope, so the
 * response does not confirm that the envelope exists — now enforced as a SQL
 * predicate inside `mustGetVisibleEnvelope`, not an application-level boolean.
 */

import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { signEnvelopes } from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { ScopedRead } from "../../access/scoped-read";
import { SignAuditService } from "../sign-audit.service";
import { SignFinalizationService } from "../sign-finalization.service";
import { SignCertificatesController } from "../sign-certificates.controller";
import { envelopeSenderScope, resolveEnvelopeViewScope, systemEnvelopeScope } from "../sign-envelope-scope";

const ORG = "org-test";
const SENDER_MEMBERSHIP = 10;
const OTHER_MEMBERSHIP = 20;
const ENVELOPE_ID = 42;
const dialect = new PgDialect();

const makeEnvelope = (senderMembershipId: number | null = SENDER_MEMBERSHIP) => ({
  id: ENVELOPE_ID,
  orgId: ORG,
  senderMembershipId,
  title: "Executed contract",
  status: "completed",
  finalPdfFileKey: "sign/final/42.pdf",
  finalPdfHash: "abc123",
});

/** Renders the predicate and decides from its SQL/params rather than ignoring it. */
function findFirstHonoringPredicate(envelope: ReturnType<typeof makeEnvelope> | null) {
  return jest.fn(async ({ where }: { where: SQL }) => {
    if (!envelope) return undefined;
    const { sql: text, params } = dialect.sqlToQuery(where);
    if (!text.includes("sender_membership_id")) return envelope; // scope "all": tenant AND true
    if (params.includes(envelope.senderMembershipId)) return envelope;
    return undefined;
  });
}

function makeService(envelope: ReturnType<typeof makeEnvelope> | null) {
  const findFirst = findFirstHonoringPredicate(envelope);
  const db = {
    query: {
      signEnvelopes: { findFirst },
      signCertificates: {
        findFirst: jest.fn().mockResolvedValue({
          id: 1,
          orgId: ORG,
          envelopeId: ENVELOPE_ID,
          certificateFileKey: "sign/cert/42.pdf",
          finalPdfHash: "abc123",
          certificateJson: {},
        }),
      },
    },
  } as unknown as Db;
  const storage = { getFileUrl: jest.fn().mockResolvedValue("https://signed.example/42") };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new SignFinalizationService(
    db,
    storage as never,
    {} as never,
    audit as never,
    {} as never,
    {} as never,
  );
  return { service, storage, audit };
}

describe("envelopeSenderScope", () => {
  it("admits every envelope at scope all, regardless of membership", () => {
    const read = ScopedRead.of(ORG, "actor", "all");
    const where = read.compose(
      { tenant: signEnvelopes.orgId, scope: envelopeSenderScope(OTHER_MEMBERSHIP) },
      ({ sql: w }) => w,
      () => { throw new Error("must not deny"); },
    );
    const { sql: text } = dialect.sqlToQuery(where);
    expect(text).not.toContain("sender_membership_id");
  });

  it("admits only the caller's own envelope below scope all", () => {
    const read = ScopedRead.of(ORG, "actor", "own");
    const where = read.compose(
      { tenant: signEnvelopes.orgId, scope: envelopeSenderScope(SENDER_MEMBERSHIP) },
      ({ sql: w }) => w,
      () => { throw new Error("must not deny"); },
    );
    const { sql: text, params } = dialect.sqlToQuery(where);
    expect(text).toContain("sender_membership_id");
    expect(params).toContain(SENDER_MEMBERSHIP);
  });

  it("admits nothing for a principal that carries no membership — fails closed", () => {
    const read = ScopedRead.of(ORG, "actor", "own");
    const where = read.compose(
      { tenant: signEnvelopes.orgId, scope: envelopeSenderScope(null) },
      ({ sql: w }) => w,
      () => { throw new Error("must not deny"); },
    );
    const { sql: text } = dialect.sqlToQuery(where);
    expect(text).toContain("false");
  });
});

describe("GET /sign/envelopes/:envelopeId/final-pdf — envelope-view scope gate", () => {
  it("returns the signed url when the caller holds sign:envelope:view at scope all", async () => {
    const { service, audit } = makeService(makeEnvelope());
    const read = ScopedRead.of(ORG, "u1", "all");
    const result = await service.getFinalPdfUrl(read, OTHER_MEMBERSHIP, ENVELOPE_ID, { userId: "u1" });
    expect(result.url).toBe("https://signed.example/42");
    expect(audit.record).toHaveBeenCalled();
  });

  it("returns the signed url when the caller is the sender and the scope is own", async () => {
    const { service } = makeService(makeEnvelope());
    const read = ScopedRead.of(ORG, "u1", "own");
    const result = await service.getFinalPdfUrl(read, SENDER_MEMBERSHIP, ENVELOPE_ID, { userId: "u1" });
    expect(result.url).toBe("https://signed.example/42");
  });

  it("throws NotFoundException for another member's envelope at scope own — the download key alone no longer reads every executed contract", async () => {
    const { service, storage, audit } = makeService(makeEnvelope());
    const read = ScopedRead.of(ORG, "u1", "own");
    await expect(
      service.getFinalPdfUrl(read, OTHER_MEMBERSHIP, ENVELOPE_ID, { userId: "u1" }),
    ).rejects.toThrow(NotFoundException);
    expect(storage.getFileUrl).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("answers 404, never 403, so the response does not confirm the envelope exists", async () => {
    const { service } = makeService(makeEnvelope());
    const read = ScopedRead.of(ORG, "u1", "own");
    await expect(
      service.getFinalPdfUrl(read, OTHER_MEMBERSHIP, ENVELOPE_ID, { userId: "u1" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("throws NotFoundException for a cross-tenant envelope id that resolves to no row in this org", async () => {
    const { service } = makeService(null);
    const read = ScopedRead.of(ORG, "u1", "all");
    await expect(
      service.getFinalPdfUrl(read, SENDER_MEMBERSHIP, ENVELOPE_ID, { userId: "u1" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("requires a scope argument, so an unscoped download is unrepresentable rather than merely discouraged", () => {
    expect(SignFinalizationService.prototype.getFinalPdfUrl.length).toBe(4);
  });
});

describe("GET /sign/envelopes/:envelopeId/certificate — envelope-view scope gate", () => {
  it("returns the certificate url at scope all", async () => {
    const { service } = makeService(makeEnvelope());
    const read = ScopedRead.of(ORG, "u1", "all");
    const result = await service.getCertificateUrl(read, OTHER_MEMBERSHIP, ENVELOPE_ID);
    expect(result.url).toBe("https://signed.example/42");
  });

  it("throws NotFoundException for another member's envelope at scope own", async () => {
    const { service, storage } = makeService(makeEnvelope());
    const read = ScopedRead.of(ORG, "u1", "own");
    await expect(
      service.getCertificateUrl(read, OTHER_MEMBERSHIP, ENVELOPE_ID),
    ).rejects.toThrow(NotFoundException);
    expect(storage.getFileUrl).not.toHaveBeenCalled();
  });

  it("requires a scope argument", () => {
    expect(SignFinalizationService.prototype.getCertificateUrl.length).toBe(3);
  });
});

function makeAuditService(envelope: ReturnType<typeof makeEnvelope> | null) {
  const rows = [{ id: 1, envelopeId: ENVELOPE_ID, eventType: "recipient_completed" }];
  const limit = jest.fn().mockResolvedValue(rows);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });
  const findFirst = findFirstHonoringPredicate(envelope);
  const db = {
    select,
    query: { signEnvelopes: { findFirst } },
  } as unknown as Db;
  return { service: new SignAuditService(db, {} as never), select, rows };
}

describe("GET /sign/envelopes/:envelopeId/audit — envelope-view scope gate", () => {
  it("returns the trail when the caller holds sign:envelope:view at scope all", async () => {
    const { service, rows } = makeAuditService(makeEnvelope());
    const read = ScopedRead.of(ORG, "u1", "all");
    await expect(
      service.listForEnvelope(read, OTHER_MEMBERSHIP, ENVELOPE_ID),
    ).resolves.toEqual(rows);
  });

  it("returns the trail when the caller is the sender and the scope is own", async () => {
    const { service, rows } = makeAuditService(makeEnvelope());
    const read = ScopedRead.of(ORG, "u1", "own");
    await expect(
      service.listForEnvelope(read, SENDER_MEMBERSHIP, ENVELOPE_ID),
    ).resolves.toEqual(rows);
  });

  it("throws NotFoundException for another member's envelope at scope own — the audit key alone no longer reads every signing trail", async () => {
    const { service, select } = makeAuditService(makeEnvelope());
    const read = ScopedRead.of(ORG, "u1", "own");
    await expect(
      service.listForEnvelope(read, OTHER_MEMBERSHIP, ENVELOPE_ID),
    ).rejects.toThrow(NotFoundException);
    expect(select).not.toHaveBeenCalled();
  });

  it("answers 404, never 403, so the response does not confirm the envelope exists", async () => {
    const { service } = makeAuditService(makeEnvelope());
    const read = ScopedRead.of(ORG, "u1", "own");
    await expect(
      service.listForEnvelope(read, OTHER_MEMBERSHIP, ENVELOPE_ID),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("gives a cross-tenant id and an out-of-scope id the same message, so the two are indistinguishable", async () => {
    const missing = makeAuditService(null);
    const outOfScope = makeAuditService(makeEnvelope());
    const crossTenant = await missing.service
      .listForEnvelope(ScopedRead.of(ORG, "u1", "all"), SENDER_MEMBERSHIP, ENVELOPE_ID)
      .catch((error: Error) => error.message);
    const denied = await outOfScope.service
      .listForEnvelope(ScopedRead.of(ORG, "u1", "own"), OTHER_MEMBERSHIP, ENVELOPE_ID)
      .catch((error: Error) => error.message);

    expect(denied).toBe(crossTenant);
  });

  it("requires a scope argument, so an unscoped read of the trail is unrepresentable", () => {
    expect(SignAuditService.prototype.listForEnvelope.length).toBe(3);
  });

  it("names the finalization pipeline's own reads as a system read rather than leaving them unscoped", () => {
    const read = systemEnvelopeScope(ORG);
    expect(read.orgId).toBe(ORG);
    expect(read.denied).toBe(false);
    expect(read.discriminator).toBe("all");
  });
});

describe("SignCertificatesController — resolves sign:envelope:view, not the download key", () => {
  const makeUser = (): CurrentUserContext =>
    ({
      orgId: ORG,
      userId: "user-other",
      isOrgOwner: false,
      principal: { kind: "human-session", membershipId: OTHER_MEMBERSHIP, isOrgOwner: false },
    }) as unknown as CurrentUserContext;

  const makeAccess = (scope: string) =>
    ({ scopeFor: jest.fn().mockResolvedValue(scope) }) as unknown as AccessService;

  it("reads the scope of sign:envelope:view rather than sign:certificate:download", async () => {
    const access = makeAccess("own");
    const scope = await resolveEnvelopeViewScope(access, makeUser());
    expect(access.scopeFor).toHaveBeenCalledWith(expect.anything(), "sign:envelope:view");
    expect(scope).toBeInstanceOf(ScopedRead);
    expect(scope.denied).toBe(false);
    expect(scope.discriminator).toBe("own:user-other");
  });

  it("forwards the caller's own membership to getFinalPdfUrl when sign:envelope:view is own", async () => {
    const finalization = {
      getFinalPdfUrl: jest.fn().mockResolvedValue({ url: "x" }),
    } as unknown as SignFinalizationService;
    const ctrl = new SignCertificatesController({} as never, finalization, makeAccess("own"));

    await ctrl.getFinalPdf(ENVELOPE_ID, makeUser(), { headers: {} } as never);

    expect(finalization.getFinalPdfUrl).toHaveBeenCalledWith(
      expect.any(ScopedRead),
      OTHER_MEMBERSHIP,
      ENVELOPE_ID,
      expect.anything(),
    );
    const forwardedScope = (finalization.getFinalPdfUrl as jest.Mock).mock.calls[0][0] as ScopedRead;
    expect(forwardedScope.denied).toBe(false);
  });

  it("forwards an unrestricted scope to getFinalPdfUrl when sign:envelope:view is all", async () => {
    const finalization = {
      getFinalPdfUrl: jest.fn().mockResolvedValue({ url: "x" }),
    } as unknown as SignFinalizationService;
    const ctrl = new SignCertificatesController({} as never, finalization, makeAccess("all"));

    await ctrl.getFinalPdf(ENVELOPE_ID, makeUser(), { headers: {} } as never);

    const forwardedScope = (finalization.getFinalPdfUrl as jest.Mock).mock.calls[0][0] as ScopedRead;
    expect(forwardedScope.discriminator).toBe("all");
  });

  it("forwards the caller's own membership to the audit list when sign:envelope:view is own", async () => {
    const audit = { listForEnvelope: jest.fn().mockResolvedValue([]) } as unknown as SignAuditService;
    const ctrl = new SignCertificatesController(audit, {} as never, makeAccess("own"));

    await ctrl.getAudit(ENVELOPE_ID, makeUser());

    expect(audit.listForEnvelope).toHaveBeenCalledWith(
      expect.any(ScopedRead),
      OTHER_MEMBERSHIP,
      ENVELOPE_ID,
    );
  });

  it("reads sign:envelope:view for the audit route too, not sign:audit:view", async () => {
    const access = makeAccess("all");
    const audit = { listForEnvelope: jest.fn().mockResolvedValue([]) } as unknown as SignAuditService;
    const ctrl = new SignCertificatesController(audit, {} as never, access);

    await ctrl.getAudit(ENVELOPE_ID, makeUser());

    expect(access.scopeFor).toHaveBeenCalledWith(expect.anything(), "sign:envelope:view");
    expect(access.scopeFor).not.toHaveBeenCalledWith(expect.anything(), "sign:audit:view");
  });

  it("forwards a denied scope to getCertificateUrl when sign:envelope:view is none", async () => {
    const finalization = {
      getCertificateUrl: jest.fn().mockResolvedValue({ url: "x" }),
    } as unknown as SignFinalizationService;
    const ctrl = new SignCertificatesController({} as never, finalization, makeAccess("none"));

    await ctrl.getCertificate(ENVELOPE_ID, makeUser());

    const forwardedScope = (finalization.getCertificateUrl as jest.Mock).mock.calls[0][0] as ScopedRead;
    expect(forwardedScope.denied).toBe(true);
  });
});
