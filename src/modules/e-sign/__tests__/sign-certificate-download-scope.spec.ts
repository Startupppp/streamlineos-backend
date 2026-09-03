/**
 * BOLA regression for `sign:certificate:download` (findings register #15).
 *
 * `sign:certificate:download` is not scopable, so a per-person
 * `user_permission_grants` row hands it out at scope "all" while the same
 * member's `sign:envelope:view` stays "own". Before the fix,
 * `GET /sign/envelopes/:envelopeId/certificate` and
 * `GET /sign/envelopes/:envelopeId/final-pdf` bound only `orgId`, so that member
 * could download every fully-executed contract PDF in the organisation — and any
 * other tenant's envelope id was the same request minus the org match.
 *
 * After the fix both routes resolve the caller's `sign:envelope:view` scope and
 * answer 404 (never 403) for an out-of-scope or cross-tenant envelope, so the
 * response does not confirm that the envelope exists.
 */

import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { SignFinalizationService } from "../sign-finalization.service";
import { SignCertificatesController } from "../sign-certificates.controller";
import { envelopeIsVisible, resolveEnvelopeViewScope } from "../sign-envelope-scope";

const ORG = "org-test";
const SENDER_MEMBERSHIP = 10;
const OTHER_MEMBERSHIP = 20;
const ENVELOPE_ID = 42;

const makeEnvelope = (senderMembershipId: number | null = SENDER_MEMBERSHIP) => ({
  id: ENVELOPE_ID,
  orgId: ORG,
  senderMembershipId,
  title: "Executed contract",
  status: "completed",
  finalPdfFileKey: "sign/final/42.pdf",
  finalPdfHash: "abc123",
});

function makeService(envelope: ReturnType<typeof makeEnvelope> | null) {
  const findFirst = jest.fn().mockResolvedValue(envelope);
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

describe("envelopeIsVisible", () => {
  it("admits every envelope at scope all", () => {
    expect(envelopeIsVisible(SENDER_MEMBERSHIP, { membershipId: OTHER_MEMBERSHIP, viewAll: true })).toBe(true);
  });

  it("admits only the caller's own envelope below scope all", () => {
    expect(envelopeIsVisible(SENDER_MEMBERSHIP, { membershipId: SENDER_MEMBERSHIP, viewAll: false })).toBe(true);
    expect(envelopeIsVisible(SENDER_MEMBERSHIP, { membershipId: OTHER_MEMBERSHIP, viewAll: false })).toBe(false);
  });

  it("admits nothing for a principal that carries no membership — fails closed", () => {
    expect(envelopeIsVisible(null, { membershipId: null, viewAll: false })).toBe(false);
  });
});

describe("GET /sign/envelopes/:envelopeId/final-pdf — envelope-view scope gate", () => {
  it("returns the signed url when the caller holds sign:envelope:view at scope all", async () => {
    const { service, audit } = makeService(makeEnvelope());
    const result = await service.getFinalPdfUrl(ORG, ENVELOPE_ID, { userId: "u1" }, { membershipId: OTHER_MEMBERSHIP, viewAll: true });
    expect(result.url).toBe("https://signed.example/42");
    expect(audit.record).toHaveBeenCalled();
  });

  it("returns the signed url when the caller is the sender and the scope is own", async () => {
    const { service } = makeService(makeEnvelope());
    const result = await service.getFinalPdfUrl(ORG, ENVELOPE_ID, { userId: "u1" }, { membershipId: SENDER_MEMBERSHIP, viewAll: false });
    expect(result.url).toBe("https://signed.example/42");
  });

  it("throws NotFoundException for another member's envelope at scope own — the download key alone no longer reads every executed contract", async () => {
    const { service, storage, audit } = makeService(makeEnvelope());
    await expect(
      service.getFinalPdfUrl(ORG, ENVELOPE_ID, { userId: "u1" }, { membershipId: OTHER_MEMBERSHIP, viewAll: false }),
    ).rejects.toThrow(NotFoundException);
    expect(storage.getFileUrl).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("answers 404, never 403, so the response does not confirm the envelope exists", async () => {
    const { service } = makeService(makeEnvelope());
    await expect(
      service.getFinalPdfUrl(ORG, ENVELOPE_ID, { userId: "u1" }, { membershipId: OTHER_MEMBERSHIP, viewAll: false }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("throws NotFoundException for a cross-tenant envelope id that resolves to no row in this org", async () => {
    const { service } = makeService(null);
    await expect(
      service.getFinalPdfUrl(ORG, ENVELOPE_ID, { userId: "u1" }, { membershipId: SENDER_MEMBERSHIP, viewAll: true }),
    ).rejects.toThrow(NotFoundException);
  });

  it("requires a scope argument, so an unscoped download is unrepresentable rather than merely discouraged", () => {
    expect(SignFinalizationService.prototype.getFinalPdfUrl.length).toBe(4);
  });
});

describe("GET /sign/envelopes/:envelopeId/certificate — envelope-view scope gate", () => {
  it("returns the certificate url at scope all", async () => {
    const { service } = makeService(makeEnvelope());
    const result = await service.getCertificateUrl(ORG, ENVELOPE_ID, { membershipId: OTHER_MEMBERSHIP, viewAll: true });
    expect(result.url).toBe("https://signed.example/42");
  });

  it("throws NotFoundException for another member's envelope at scope own", async () => {
    const { service, storage } = makeService(makeEnvelope());
    await expect(
      service.getCertificateUrl(ORG, ENVELOPE_ID, { membershipId: OTHER_MEMBERSHIP, viewAll: false }),
    ).rejects.toThrow(NotFoundException);
    expect(storage.getFileUrl).not.toHaveBeenCalled();
  });

  it("requires a scope argument", () => {
    expect(SignFinalizationService.prototype.getCertificateUrl.length).toBe(3);
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
    expect(scope).toEqual({ membershipId: OTHER_MEMBERSHIP, viewAll: false });
  });

  it("forwards viewAll:false to getFinalPdfUrl when sign:envelope:view is own", async () => {
    const finalization = {
      getFinalPdfUrl: jest.fn().mockResolvedValue({ url: "x" }),
    } as unknown as SignFinalizationService;
    const ctrl = new SignCertificatesController({} as never, finalization, makeAccess("own"));

    await ctrl.getFinalPdf(ENVELOPE_ID, makeUser(), { headers: {} } as never);

    expect(finalization.getFinalPdfUrl).toHaveBeenCalledWith(
      ORG,
      ENVELOPE_ID,
      expect.anything(),
      expect.objectContaining({ viewAll: false, membershipId: OTHER_MEMBERSHIP }),
    );
  });

  it("forwards viewAll:true to getFinalPdfUrl when sign:envelope:view is all", async () => {
    const finalization = {
      getFinalPdfUrl: jest.fn().mockResolvedValue({ url: "x" }),
    } as unknown as SignFinalizationService;
    const ctrl = new SignCertificatesController({} as never, finalization, makeAccess("all"));

    await ctrl.getFinalPdf(ENVELOPE_ID, makeUser(), { headers: {} } as never);

    expect(finalization.getFinalPdfUrl).toHaveBeenCalledWith(
      ORG,
      ENVELOPE_ID,
      expect.anything(),
      expect.objectContaining({ viewAll: true }),
    );
  });

  it("forwards viewAll:false to getCertificateUrl when sign:envelope:view is none", async () => {
    const finalization = {
      getCertificateUrl: jest.fn().mockResolvedValue({ url: "x" }),
    } as unknown as SignFinalizationService;
    const ctrl = new SignCertificatesController({} as never, finalization, makeAccess("none"));

    await ctrl.getCertificate(ENVELOPE_ID, makeUser());

    expect(finalization.getCertificateUrl).toHaveBeenCalledWith(
      ORG,
      ENVELOPE_ID,
      expect.objectContaining({ viewAll: false }),
    );
  });
});
