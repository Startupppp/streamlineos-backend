import { Test } from "@nestjs/testing";
import { ForbiddenException, INestApplication, NotFoundException } from "@nestjs/common";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { AppModule } from "../../../app.module";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { organizations, users, signRecipients, signCertificates, subscriptions } from "../../../db/schema";
import { seedOrg } from "../../../../test/helpers/e2e-seed";
import { installFixtureRegionRegistry } from "../../../../test/helpers/e2e-app";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { StorageService } from "../../storage/storage.service";
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

const memStore = new Map<string, Buffer>();
const storageStub = {
  isConfigured: () => true,
  uploadFile: async (_orgId: string, buffer: Buffer, folder = "uploads", fileName = "file", mimeType = "application/octet-stream") => {
    const key = `${folder}/${fileName}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    memStore.set(key, buffer);
    return { key, url: `https://test.local/${key}`, size: buffer.length, mimeType };
  },
  getFileStream: async (_orgId: string, key: string) => {
    const buf = memStore.get(key);
    if (!buf) throw new NotFoundException(`Storage stub: key not found: ${key}`);
    return { body: Readable.from([buf]) as Readable, contentType: "application/octet-stream", contentLength: buf.length };
  },
  getFileUrl: async (_orgId: string, key: string, _expiry: number) => `https://test.local/${key}`,
  deleteFile: jest.fn().mockResolvedValue(undefined),
  getFileKeyFromUrl: (url: string) => url.replace("https://test.local/", ""),
  getFileNameFromKey: (key: string) => key.split("/").pop() ?? "file",
  getMimeType: () => "application/octet-stream",
  isValidFileKey: () => true,
};

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

  function inOrg<T>(fn: () => Promise<T>): Promise<T> {
    return runInTenantTransaction(db, () => fn(), { orgId: ORG_ID });
  }

  function inOrgOf<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    return runInTenantTransaction(db, () => fn(), { orgId });
  }

  async function cleanup(): Promise<void> {
    await db.delete(organizations).where(eq(organizations.id, ORG_ID));
    await db.delete(organizations).where(eq(organizations.id, ORG_B_ID));
    await db.delete(users).where(eq(users.id, USER_ID));
    await db.delete(users).where(eq(users.id, USER_B_ID));
    await db.delete(users).where(eq(users.id, `${ORG_ID}-seed-owner`));
    await db.delete(users).where(eq(users.id, `${ORG_B_ID}-seed-owner`));
  }

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SignNotificationsService)
      .useValue(mockNotifications)
      .overrideProvider(StorageService)
      .useValue(storageStub)
      .compile();
    app = ref.createNestApplication();
    await app.init();

    db = app.get(DRIZZLE);
    installFixtureRegionRegistry(db);
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
     * only inside a transaction. `seedOrg` is the transaction that makes the
     * cycle legal, and it sets the tenant context the membership insert needs.
     */
    await seedOrg(db, ORG_ID, `${P}slug`);
    await seedOrg(db, ORG_B_ID, `${P}slug-b`);
    await db.insert(users).values({ id: USER_ID, email: `${P}sender@example.com`, name: "Sender" }).onConflictDoNothing();
    await db.insert(users).values({ id: USER_B_ID, email: `${P}sender-b@example.com`, name: "Sender B" }).onConflictDoNothing();
    /**
     * A paid plan, because the Free one allows three envelopes and this suite
     * creates one per case in ORG_ID — from the fourth onwards
     * `assertWithinLimit` would refuse with QUOTA_EXCEEDED. ORG_B creates one.
     */
    await runInTenantTransaction(db, async () => {
      await db.insert(subscriptions).values({ orgId: ORG_ID, plan: "ENTERPRISE", status: "ACTIVE" }).onConflictDoNothing();
    }, { orgId: ORG_ID });
  }, 90_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
  }, 45_000);

  async function createEnvelopeWithSigner(opts?: { watermarkPolicyId?: number; orgId?: string; userId?: string }) {
    const orgId = opts?.orgId ?? ORG_ID;
    const userId = opts?.userId ?? USER_ID;
    const localActor: RequestActorContext = { orgId, userId };
    const pdfBuffer = await makeTestPdfBuffer();

    return runInTenantTransaction(db, async () => {
      const envelope = await envelopesSvc.create(orgId, null, {
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
    }, { orgId });
  }

  async function issueRawTokenFor(recipientId: number, expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)): Promise<string> {
    const raw = tokensSvc.generateSigningToken();
    await inOrg(() =>
      db.update(signRecipients)
        .set({ status: "invited", signingTokenHash: tokensSvc.hash(raw), tokenExpiresAt: expiresAt, tokenRevokedAt: null })
        .where(eq(signRecipients.id, recipientId)),
    );
    return raw;
  }

  it("blocks completion when a required signature field has not been filled", async () => {
    const { envelope, recipient } = await createEnvelopeWithSigner();
    await inOrg(() => envelopesSvc.send(ORG_ID, envelope.id, actor));
    const token = await issueRawTokenFor(recipient.id);

    await publicSvc.getSession(token, {});
    await publicSvc.acceptConsent(token, { disclosureVersion: "v1" }, {});

    await expect(publicSvc.complete(token, {})).rejects.toMatchObject({
      response: expect.objectContaining({ message: expect.stringContaining("required fields") }),
    });
  }, 45_000);

  it("completes a full signing flow and finalizes idempotently with a real certificate and final PDF", async () => {
    const { envelope, recipient } = await createEnvelopeWithSigner();
    await inOrg(() => envelopesSvc.send(ORG_ID, envelope.id, actor));
    const token = await issueRawTokenFor(recipient.id);

    await publicSvc.getSession(token, {});
    await publicSvc.acceptConsent(token, { disclosureVersion: "v1" }, {});
    await publicSvc.adoptSignature(token, { assetType: "signature", method: "typed", typedText: "Jane Signer" }, {});

    const outcome = await publicSvc.complete(token, {});
    expect(outcome.completed).toBe(true);
    expect(outcome.envelopeCompleted).toBe(true);

    const completedEnvelope = await inOrg(() => envelopesSvc.mustGet(ORG_ID, envelope.id));
    expect(completedEnvelope.status).toBe("completed");

    const first = await inOrg(() => finalizationSvc.finalize(ORG_ID, envelope.id));
    const second = await inOrg(() => finalizationSvc.finalize(ORG_ID, envelope.id));
    expect(first.certificateNumber).toBe(second.certificateNumber);

    const certRows = await inOrg(() => db.select().from(signCertificates).where(eq(signCertificates.envelopeId, envelope.id)));
    expect(certRows).toHaveLength(1);
    expect(certRows[0]?.certificateNumber).toMatch(/^SGN-\d+-[A-F0-9]+$/);
    expect(certRows[0]?.certificateFileKey).toBeTruthy();

    const finalizedEnvelope = await inOrg(() => envelopesSvc.mustGet(ORG_ID, envelope.id));
    expect(finalizedEnvelope.finalPdfFileKey).toBeTruthy();
    expect(finalizedEnvelope.finalPdfHash).toBeTruthy();

    const events = await inOrg(() => auditSvc.listForEnvelope(ORG_ID, envelope.id));
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
  }, 45_000);

  it("marks a session expired once its token has passed tokenExpiresAt, and blocks signing", async () => {
    const { recipient } = await createEnvelopeWithSigner();
    const token = await issueRawTokenFor(recipient.id, new Date(Date.now() - 60_000));

    const session = await publicSvc.getSession(token, {});
    expect(session.state).toBe("expired");
    await expect(publicSvc.complete(token, {})).rejects.toThrow(ForbiddenException);
  }, 45_000);

  it("revokes every outstanding signing link when the envelope is voided", async () => {
    const { envelope, recipient } = await createEnvelopeWithSigner();
    await inOrg(() => envelopesSvc.send(ORG_ID, envelope.id, actor));
    const token = await issueRawTokenFor(recipient.id);

    await inOrg(() => envelopesSvc.voidEnvelope(ORG_ID, envelope.id, { reason: "test void" }, actor));

    const session = await publicSvc.getSession(token, {});
    expect(session.state).toBe("envelope_voided");
    await expect(publicSvc.complete(token, {})).rejects.toThrow(ForbiddenException);
  }, 45_000);

  it("records a decline, moves the envelope to declined, and blocks further signing on that link", async () => {
    const { envelope, recipient } = await createEnvelopeWithSigner();
    await inOrg(() => envelopesSvc.send(ORG_ID, envelope.id, actor));
    const token = await issueRawTokenFor(recipient.id);

    await publicSvc.getSession(token, {});
    await publicSvc.acceptConsent(token, { disclosureVersion: "v1" }, {});
    await publicSvc.decline(token, { reason: "Not agreeing to terms" }, {});

    const declinedEnvelope = await inOrg(() => envelopesSvc.mustGet(ORG_ID, envelope.id));
    expect(declinedEnvelope.status).toBe("declined");

    const events = await inOrg(() => auditSvc.listForEnvelope(ORG_ID, envelope.id));
    expect(events.some((e) => e.eventType === "recipient_declined")).toBe(true);

    await expect(publicSvc.complete(token, {})).rejects.toThrow(ForbiddenException);
  }, 45_000);

  it("stamps the final PDF as watermarked when a matching tenant watermark policy is configured", async () => {
    const policy = await inOrg(() => watermarkSvc.create(ORG_ID, USER_ID, {
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
    }));

    const { envelope, recipient } = await createEnvelopeWithSigner({ watermarkPolicyId: policy.id });
    await inOrg(() => envelopesSvc.send(ORG_ID, envelope.id, actor));
    const token = await issueRawTokenFor(recipient.id);

    await publicSvc.getSession(token, {});
    await publicSvc.acceptConsent(token, { disclosureVersion: "v1" }, {});
    await publicSvc.adoptSignature(token, { assetType: "signature", method: "typed", typedText: "Jane Signer" }, {});
    await publicSvc.complete(token, {});

    const certificate = await inOrg(() => finalizationSvc.finalize(ORG_ID, envelope.id));
    expect(certificate.watermarked).toBe(true);
  }, 45_000);

  it("enforces tenant isolation: org A cannot fetch an envelope that belongs to org B", async () => {
    const { envelope: orgBEnvelope } = await createEnvelopeWithSigner({ orgId: ORG_B_ID, userId: USER_B_ID });

    await expect(inOrg(() => envelopesSvc.mustGet(ORG_ID, orgBEnvelope.id))).rejects.toBeInstanceOf(NotFoundException);

    const visibleToOrgB = await inOrgOf(ORG_B_ID, () => envelopesSvc.mustGet(ORG_B_ID, orgBEnvelope.id));
    expect(visibleToOrgB.id).toBe(orgBEnvelope.id);
  }, 45_000);
});
