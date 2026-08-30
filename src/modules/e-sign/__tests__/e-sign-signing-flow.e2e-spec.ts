import { Test } from "@nestjs/testing";
import { seedOrg } from "test/helpers/e2e-seed";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { StorageService } from "src/modules/storage/storage.service";
import { installFixtureRegionRegistry } from "test/helpers/e2e-app";
import { INestApplication, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { AppModule } from "../../../app.module";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { organizations, users, signRecipients, signCertificates, subscriptions } from "../../../db/schema";
import { SignEnvelopesService } from "../sign-envelopes.service";
import { SignDocumentsService } from "../sign-documents.service";
import { SignRecipientsService } from "../sign-recipients.service";
import { SignFieldsService } from "../sign-fields.service";
import { SignPublicService } from "../sign-public.service";
import { SignFinalizationService } from "../sign-finalization.service";
import { SignAuditService } from "../sign-audit.service";
import { SignTokensService } from "../sign-tokens.service";
import { SignWatermarkService } from "../sign-watermark.service";
import { SignNotificationsService } from "../sign-notifications.service";
import type { RequestActorContext } from "../../../common/audit/actor-context";

const P = "e2e-signos-flow-";
const ORG_ID = `${P}org`;
const ORG_B_ID = `${P}org-b`;
const USER_ID = `${P}sender`;
const USER_B_ID = `${P}sender-b`;

async function makeTestPdfBuffer(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

const mockNotifications = {
  sendCcNotice: jest.fn().mockResolvedValue(undefined),
  sendOtpCode: jest.fn().mockResolvedValue(undefined),
  sendInvitation: jest.fn().mockResolvedValue(undefined),
  sendReminder: jest.fn().mockResolvedValue(undefined),
  sendCompletedToRecipient: jest.fn().mockResolvedValue(undefined),
  sendDeclinedToSender: jest.fn().mockResolvedValue(undefined),
  sendVoidedToRecipient: jest.fn().mockResolvedValue(undefined),
  sendBulkJobCompleted: jest.fn().mockResolvedValue(undefined),
};


/**
 * Object storage, in memory.
 *
 * The signing flow uploads a PDF and writes a finalized one back, and
 * `SignDocumentsService` refuses outright when storage is not configured — so
 * without a substitute this suite needs an S3-compatible backend to assert
 * anything about signing at all. `ar-document-pdf.e2e-spec.ts` already stubs it
 * this way for the same reason; the bytes go in a Map and come back out, which
 * is the only property any assertion here depends on.
 */
class InMemoryStorage {
  readonly objects = new Map<string, Buffer>();

  isConfigured(): boolean {
    return true;
  }

  // `(orgId, buffer, folder, fileName, mimeType)` — the real signature. Copying
  // the four-argument shape from another suite's stub put the PDF buffer where
  // the folder goes, so the storage key carried NUL bytes and the insert died on
  // `invalid byte sequence for encoding "UTF8": 0x00`.
  uploadFile(_orgId: string, buffer: Buffer, folder: string, fileName: string, mimeType: string) {
    const key = `${folder}/${randomUUID()}-${fileName.replace(/[^a-zA-Z0-9.-]/g, "-")}`;
    this.objects.set(key, Buffer.from(buffer));
    return Promise.resolve({ url: `https://files.test/${key}`, key, size: buffer.length, mimeType });
  }

  getFileStream(_orgId: string, key: string) {
    const object = this.objects.get(key);
    if (!object) return Promise.reject(new NotFoundException("File not found or empty"));
    return Promise.resolve({
      body: Readable.from([object]),
      contentType: "application/pdf",
      contentLength: object.length,
    });
  }

  getFileUrl(_orgId: string, key: string): Promise<string> {
    return Promise.resolve(`https://files.test/${key}`);
  }

  deleteFile(_orgId: string, key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}

describe("SignOS signing flow integration (e2e)", () => {
  let app: INestApplication;
  let db: Db;
  let envelopesSvc: SignEnvelopesService;
  let documentsSvc: SignDocumentsService;
  let recipientsSvc: SignRecipientsService;
  let fieldsSvc: SignFieldsService;
  let publicSvc: SignPublicService;
  let finalizationSvc: SignFinalizationService;
  let auditSvc: SignAuditService;
  let tokensSvc: SignTokensService;
  let watermarkSvc: SignWatermarkService;

  const actor: RequestActorContext = { orgId: ORG_ID, userId: USER_ID };

  async function cleanup(): Promise<void> {
    await db.delete(organizations).where(eq(organizations.id, ORG_ID));
    await db.delete(organizations).where(eq(organizations.id, ORG_B_ID));
    await db.delete(users).where(eq(users.id, USER_ID));
    await db.delete(users).where(eq(users.id, USER_B_ID));
  }

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SignNotificationsService)
      .useValue(mockNotifications)
      .overrideProvider(StorageService)
      .useValue(new InMemoryStorage())
      .compile();

    /**
     * Place the fixture organisations before anything reads their data.
     *
     * They are real rows here, but nothing gives them a `region`, and
     * `regionForOrg` fails closed on an unplaced tenant — correctly, since a
     * silent fallback is how one tenant's rows land in another region's
     * database. `createE2eApp` installs this same stub for the same reason;
     * this suite builds its own module.
     */
    installFixtureRegionRegistry(ref.get<Db>(DRIZZLE));

    app = ref.createNestApplication();
    await app.init();

    db = app.get(DRIZZLE);
    envelopesSvc = app.get(SignEnvelopesService);
    documentsSvc = app.get(SignDocumentsService);
    recipientsSvc = app.get(SignRecipientsService);
    fieldsSvc = app.get(SignFieldsService);
    publicSvc = app.get(SignPublicService);
    finalizationSvc = app.get(SignFinalizationService);
    auditSvc = app.get(SignAuditService);
    tokensSvc = app.get(SignTokensService);
    watermarkSvc = app.get(SignWatermarkService);

    await cleanup();

    /**
     * Seeded through the helper rather than by hand.
     *
     * `organizations.owner_membership_id` is NOT NULL with a composite key to
     * `organization_members`, so an org needs a membership that needs the org.
     * The constraint is `DEFERRABLE INITIALLY DEFERRED` for that reason — but
     * only inside a transaction. These two inserts ran outside one, so the
     * deferred check fired at statement end and the whole suite failed to seed,
     * then failed every case in it. `seedOrg` is the transaction that makes the
     * cycle legal, and it sets the tenant context the membership insert needs.
     */
    await seedOrg(db, ORG_ID, `${P}slug`);
    await seedOrg(db, ORG_B_ID, `${P}slug-b`);

    /**
     * A paid plan, because the Free one allows three envelopes.
     *
     * This suite creates one per case and there are seven, so from the fourth
     * onwards `assertWithinLimit` refused with QUOTA_EXCEEDED — the limit
     * working exactly as intended, on a fixture that never said which plan it
     * was on. `STARTER` is what `PlanLimitsService` resolves to tier PAID;
     * there is no plan literally named PAID.
     */
    for (const orgId of [ORG_ID, ORG_B_ID])
      await runInNewTenantTransaction(db, orgId, (tx) =>
        tx.insert(subscriptions).values({ orgId, plan: "STARTER", status: "ACTIVE" }),
      );
    await db.insert(users).values({ id: USER_ID, email: `${P}sender@example.com`, name: "Sender" });
    await db.insert(users).values({ id: USER_B_ID, email: `${P}sender-b@example.com`, name: "Sender B" });
  }, 90_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
  }, 45_000);

  /**
   * Every service call in this file runs inside a tenant transaction.
   *
   * These are services called directly, not routes driven over HTTP — so the
   * per-request seam that sets `app.organization_id` in production never runs,
   * and every write to a table behind RLS is refused with 42501. Wrapping here
   * is what that seam does, and it is per call rather than per suite because the
   * isolation case deliberately works with two organisations.
   */
  const inOrg = <T>(orgId: string, fn: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(db, orgId, fn);

  /**
   * Runs in the caller's tenant context rather than opening its own.
   *
   * A nested `runInNewTenantTransaction` is a separate transaction on a separate
   * connection, so it cannot see rows the outer one has written and not
   * committed — the watermark case creates a policy and then an envelope
   * referencing it, and the second could not see the first. The isolation case
   * is the one place two organisations are in play, and it says so explicitly.
   */
  async function createEnvelopeWithSigner(opts?: { watermarkPolicyId?: number; orgId?: string; userId?: string }) {
    const orgId = opts?.orgId ?? ORG_ID;
    const userId = opts?.userId ?? USER_ID;
    const localActor: RequestActorContext = { orgId, userId };


      const envelope = await envelopesSvc.create(orgId, userId, {
        title: "Test agreement",
        routingMode: "parallel",
        ccTiming: "on_complete",
        allowDecline: true,
        reminderEnabled: true,
        reminderFirstAfterDays: 3,
        reminderRepeatDays: 3,
        reminderMaxCount: 5,
        watermarkPolicyId: opts?.watermarkPolicyId,
      });

      const pdfBuffer = await makeTestPdfBuffer();
      const document = await documentsSvc.upload(
        envelope.id,
        { buffer: pdfBuffer, originalName: "agreement.pdf", mimeType: "application/pdf", size: pdfBuffer.length },
        0,
        { orgId, userId },
      );

      const recipient = await recipientsSvc.add(
        orgId,
        envelope.id,
        {
          roleName: "Signer 1",
          recipientType: "signer",
          name: "Jane Signer",
          email: `${P}signer@example.com`,
          routingOrder: 1,
          authMethod: "email_link",
        },
        localActor,
      );

      const field = await fieldsSvc.add(
        orgId,
        envelope.id,
        {
          documentId: document.id,
          recipientId: recipient.id,
          fieldType: "signature",
          pageNumber: 1,
          x: 50,
          y: 50,
          width: 150,
          height: 40,
          required: true,
          readonly: false,
          orderIndex: 0,
        },
        localActor,
      );

    return { envelope, document, recipient, field };
  }

  async function issueRawTokenFor(recipientId: number, expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)): Promise<string> {
    const raw = tokensSvc.generateSigningToken();
    await db
      .update(signRecipients)
      .set({ status: "invited", signingTokenHash: tokensSvc.hash(raw), tokenExpiresAt: expiresAt, tokenRevokedAt: null })
      .where(eq(signRecipients.id, recipientId));
    return raw;
  }

  it("blocks completion when a required signature field has not been filled", async () => {
    return inOrg(ORG_ID, async () => {
      const { envelope, recipient } = await createEnvelopeWithSigner();
      await envelopesSvc.send(ORG_ID, envelope.id, actor);
      const token = await issueRawTokenFor(recipient.id);

      await publicSvc.getSession(token, {});
      await publicSvc.acceptConsent(token, { disclosureVersion: "v1" }, {});

      await expect(publicSvc.complete(token, {})).rejects.toMatchObject({
        response: expect.objectContaining({ message: expect.stringContaining("required fields") }),
      });
  
    });
}, 45_000);

  it("completes a full signing flow and finalizes idempotently with a real certificate and final PDF", async () => {
    return inOrg(ORG_ID, async () => {
      const { envelope, recipient } = await createEnvelopeWithSigner();
      await envelopesSvc.send(ORG_ID, envelope.id, actor);
      const token = await issueRawTokenFor(recipient.id);

      await publicSvc.getSession(token, {});
      await publicSvc.acceptConsent(token, { disclosureVersion: "v1" }, {});
      await publicSvc.adoptSignature(token, { assetType: "signature", method: "typed", typedText: "Jane Signer" }, {});

      const outcome = await publicSvc.complete(token, {});
      expect(outcome.completed).toBe(true);
      expect(outcome.envelopeCompleted).toBe(true);

      const completedEnvelope = await envelopesSvc.mustGet(ORG_ID, envelope.id);
      expect(completedEnvelope.status).toBe("completed");

      const [first, second] = await Promise.all([
        finalizationSvc.finalize(ORG_ID, envelope.id),
        finalizationSvc.finalize(ORG_ID, envelope.id),
      ]);
      expect(first.certificateNumber).toBe(second.certificateNumber);

      const certRows = await db.select().from(signCertificates).where(eq(signCertificates.envelopeId, envelope.id));
      expect(certRows).toHaveLength(1);
      expect(certRows[0]?.certificateNumber).toMatch(/^SGN-\d+-[A-F0-9]+$/);
      expect(certRows[0]?.certificateFileKey).toBeTruthy();

      const finalizedEnvelope = await envelopesSvc.mustGet(ORG_ID, envelope.id);
      expect(finalizedEnvelope.finalPdfFileKey).toBeTruthy();
      expect(finalizedEnvelope.finalPdfHash).toBeTruthy();

      const events = await auditSvc.listForEnvelope(ORG_ID, envelope.id);
      const eventTypes = new Set<string>(events.map((e) => e.eventType));
      for (const expected of [
        "envelope_created",
        "envelope_sent",
        "signing_link_opened",
        "consent_accepted",
        "signature_adopted",
        "recipient_completed",
        "envelope_completed",
        "final_pdf_generated",
        "certificate_generated",
      ]) {
        expect(eventTypes.has(expected)).toBe(true);
      }
  
    });
}, 45_000);

  it("marks a session expired once its token has passed tokenExpiresAt, and blocks signing", async () => {
    return inOrg(ORG_ID, async () => {
      const { recipient } = await createEnvelopeWithSigner();
      const token = await issueRawTokenFor(recipient.id, new Date(Date.now() - 60_000));

      const session = await publicSvc.getSession(token, {});
      expect(session.state).toBe("expired");
      await expect(publicSvc.complete(token, {})).rejects.toThrow();
  
    });
}, 45_000);

  it("revokes every outstanding signing link when the envelope is voided", async () => {
    return inOrg(ORG_ID, async () => {
      const { envelope, recipient } = await createEnvelopeWithSigner();
      await envelopesSvc.send(ORG_ID, envelope.id, actor);
      const token = await issueRawTokenFor(recipient.id);

      await envelopesSvc.voidEnvelope(ORG_ID, envelope.id, { reason: "test void" }, actor);

      const session = await publicSvc.getSession(token, {});
      expect(session.state).toBe("envelope_voided");
      await expect(publicSvc.complete(token, {})).rejects.toThrow();
  
    });
}, 45_000);

  it("records a decline, moves the envelope to declined, and blocks further signing on that link", async () => {
    return inOrg(ORG_ID, async () => {
      const { envelope, recipient } = await createEnvelopeWithSigner();
      await envelopesSvc.send(ORG_ID, envelope.id, actor);
      const token = await issueRawTokenFor(recipient.id);

      await publicSvc.getSession(token, {});
      await publicSvc.acceptConsent(token, { disclosureVersion: "v1" }, {});
      await publicSvc.decline(token, { reason: "Not agreeing to terms" }, {});

      const declinedEnvelope = await envelopesSvc.mustGet(ORG_ID, envelope.id);
      expect(declinedEnvelope.status).toBe("declined");

      const events = await auditSvc.listForEnvelope(ORG_ID, envelope.id);
      expect(events.some((e) => e.eventType === "recipient_declined")).toBe(true);

      await expect(publicSvc.complete(token, {})).rejects.toThrow();
  
    });
}, 45_000);

  it("stamps the final PDF as watermarked when a matching tenant watermark policy is configured", async () => {
    return inOrg(ORG_ID, async () => {
      const policy = await watermarkSvc.create(ORG_ID, USER_ID, {
        scopeType: "tenant",
        appliesStates: ["completed"],
        text: "CONFIDENTIAL",
        opacity: 30,
        angle: 45,
        color: "#94A3B8",
        fontSize: 36,
        placement: "diagonal_tiled",
        pages: { mode: "all" },
        showOnFinalPdf: true,
        previewOnly: false,
        enabled: true,
      });

      const { envelope, recipient } = await createEnvelopeWithSigner({ watermarkPolicyId: policy.id });
      await envelopesSvc.send(ORG_ID, envelope.id, actor);
      const token = await issueRawTokenFor(recipient.id);

      await publicSvc.getSession(token, {});
      await publicSvc.acceptConsent(token, { disclosureVersion: "v1" }, {});
      await publicSvc.adoptSignature(token, { assetType: "signature", method: "typed", typedText: "Jane Signer" }, {});
      await publicSvc.complete(token, {});

      const certificate = await finalizationSvc.finalize(ORG_ID, envelope.id);
      expect(certificate.watermarked).toBe(true);
  
    });
}, 45_000);

  it("enforces tenant isolation: org A cannot fetch an envelope that belongs to org B", async () => {
    return inOrg(ORG_ID, async () => {
      const { envelope: orgBEnvelope } = await inOrg(ORG_B_ID, () =>
        createEnvelopeWithSigner({ orgId: ORG_B_ID, userId: USER_B_ID }),
      );

      await expect(envelopesSvc.mustGet(ORG_ID, orgBEnvelope.id)).rejects.toBeInstanceOf(NotFoundException);

      // Read back in B's own context. RLS is doing the same job as the service's
      // `org_id` predicate here, so a B-owned row is invisible from inside A's
      // transaction — which is the point of the case, and also why this half
      // cannot share it.
      const visibleToOrgB = await inOrg(ORG_B_ID, () =>
        envelopesSvc.mustGet(ORG_B_ID, orgBEnvelope.id),
      );
      expect(visibleToOrgB.id).toBe(orgBEnvelope.id);
  
    });
}, 45_000);
});
