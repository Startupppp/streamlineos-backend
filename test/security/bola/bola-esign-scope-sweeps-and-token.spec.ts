/**
 * BOLA sweep of the e-sign module — the defects it found, and the signer
 * token surface it cleared.
 *
 * The module was explicitly NOT covered by the earlier triage pass (its report
 * says "Not touched: storage, cron, e-sign, build"); report 15e then closed the
 * three envelope-child list routes and `GET /sign/documents/:documentId/preview`.
 * This file covers what neither pass reached.
 *
 *   E1  POST /sign/envelopes/:envelopeId/ai/summarize      within-tenant scope escalation
 *   E2  POST /sign/admin/run-{reminder,expiration}-sweep   no tenant predicate at all
 *
 * (E3, `POST /sign/templates/:templateId/publish-public-form` answering a 23505
 * as a 500, is gone with the route: migration 0660b retired sign public forms.)
 *
 * Plus the public signer-token surface (`@Public() /public/sign/:token/**`),
 * which is the most dangerous part of the module because a signing link is by
 * design usable by someone outside the organisation. Those assertions are
 * characterisation, not repair: they pin that a token scoped to one envelope
 * cannot read another envelope's document or write another recipient's field,
 * and that the session dies on `tokenExpiresAt` and on revocation.
 */

import { ScopedRead } from "../../../src/modules/access/scoped-read";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { signEnvelopes, signRecipients } from "../../../src/db/schema";
import { matchesPredicate } from "../../../src/test/sql-predicate";
import type { Db } from "../../../src/db/drizzle.module";
import type { CurrentUserContext } from "../../../src/common/auth/backend-claims";
import type { AccessService } from "../../../src/modules/access/access.service";
import { SignAiService } from "../../../src/modules/e-sign/sign-ai.service";
import { SignAiController } from "../../../src/modules/e-sign/sign-ai.controller";
import { SignEnvelopeSweepsService } from "../../../src/modules/e-sign/sign-envelope-sweeps.service";
import { SignPublicService } from "../../../src/modules/e-sign/sign-public.service";

const CALLER_ORG = "org-caller";
const OTHER_ORG = "org-other";
const CALLER_MEMBERSHIP = 10;
const OTHER_MEMBERSHIP = 20;

const OWN_ENVELOPE_ID = 42;
/** An envelope id that exists, but in another organisation. */
const CROSS_TENANT_ENVELOPE_ID = 777;
/** An envelope id that exists in no organisation at all. */
const ABSENT_ENVELOPE_ID = 999999;

/**
 * `matchesPredicate` binds a row by PHYSICAL column name, because that is what a
 * Drizzle `Column` chunk carries. A camelCase fixture reads `null` for every
 * column, the predicate matches nothing, and the "another tenant's row does not
 * match" half of an assertion passes for the wrong reason. This projects the
 * fixture the service consumes into the shape the predicate evaluator reads, so
 * one object cannot drift from the other.
 */
function asColumns(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), value]),
  );
}

/* ------------------------------------------------------------------ *
 * E1 — POST /sign/envelopes/:envelopeId/ai/summarize
 * ------------------------------------------------------------------ */

describe("E1 · POST /sign/envelopes/:envelopeId/ai/summarize resolves the envelope under the caller's scope", () => {
  interface AiHarness {
    service: SignAiService;
    documentFindMany: jest.Mock;
    getFileStream: jest.Mock;
    invokeText: jest.Mock;
  }

  function makeAi(visibleEnvelopeId: number): AiHarness {
    const documentFindMany = jest.fn().mockResolvedValue([]);
    /**
     * `transaction` is here because summarize now takes the envelope and
     * document reads inside a short `runInTenantTransaction` that commits
     * before the object-store fetch and the provider call. Without it the
     * sweep dies in `withTenant` on `regional.transaction is not a function`
     * and proves nothing about scope — the same reason the double at the
     * public-token sweep below carries one.
     */
    const reads = {
      /**
       * `withTenant` sets its GUCs with one `tx.execute(sql\`SELECT …\`)` before
       * it hands the transaction to the callback. No placement is resolved in a
       * unit test, so nothing reads the result and an empty row set is the
       * honest answer.
       */
      execute: jest.fn(() => Promise.resolve([])),
      query: {
        signEnvelopes: {
          // Sender visibility is in the WHERE clause now, so the double must read it or a leak would read as a pass.
          findFirst: jest.fn((args: { where: SQL }) => {
            if (visibleEnvelopeId !== OWN_ENVELOPE_ID) return Promise.resolve(undefined);
            const rendered = new PgDialect().sqlToQuery(args.where);
            if (
              rendered.sql.includes("sender_membership_id") &&
              !rendered.params.includes(CALLER_MEMBERSHIP)
            )
              return Promise.resolve(undefined);
            return Promise.resolve({
              id: OWN_ENVELOPE_ID,
              orgId: CALLER_ORG,
              senderMembershipId: CALLER_MEMBERSHIP,
            });
          }),
        },
        signDocuments: { findMany: documentFindMany },
      },
    };
    const db = {
      ...reads,
      transaction: (fn: (tx: unknown) => unknown) => fn(reads),
    } as unknown as Db;
    const getFileStream = jest.fn();
    const invokeText = jest.fn();
    const service = new SignAiService(
      db,
      { getFileStream } as never,
      { invokeText } as never,
    );
    return { service, documentFindMany, getFileStream, invokeText };
  }

  const allRead = () => ScopedRead.of(CALLER_ORG, "u1", "all");
  const ownRead = () => ScopedRead.of(CALLER_ORG, "u1", "own");

  it("summarizes an envelope the caller can see", async () => {
    const h = makeAi(OWN_ENVELOPE_ID);
    await expect(h.service.summarizeDocument(CALLER_ORG, OWN_ENVELOPE_ID, "u1", allRead(), CALLER_MEMBERSHIP)).resolves.toEqual({
      summary: "No documents attached to this envelope.",
    });
    expect(h.documentFindMany).toHaveBeenCalledTimes(1);
  });

  it("throws NotFoundException — never Forbidden — for another organisation's envelope id", async () => {
    const h = makeAi(CROSS_TENANT_ENVELOPE_ID);
    const error = await h.service
      .summarizeDocument(CALLER_ORG, CROSS_TENANT_ENVELOPE_ID, "u1", allRead(), CALLER_MEMBERSHIP)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect(error).not.toBeInstanceOf(ForbiddenException);
  });

  it("refuses an in-org envelope the caller's sign:envelope:view scope excludes — the escalation the fix closes", async () => {
    const h = makeAi(OWN_ENVELOPE_ID);
    await expect(
      h.service.summarizeDocument(CALLER_ORG, OWN_ENVELOPE_ID, "u1", ownRead(), OTHER_MEMBERSHIP),
    ).rejects.toThrow(NotFoundException);
  });

  it("never reads a document, never opens the object store and never spends an AI credit on a refusal", async () => {
    const h = makeAi(OWN_ENVELOPE_ID);
    await expect(
      h.service.summarizeDocument(CALLER_ORG, OWN_ENVELOPE_ID, "u1", ownRead(), OTHER_MEMBERSHIP),
    ).rejects.toThrow(NotFoundException);
    expect(h.documentFindMany).not.toHaveBeenCalled();
    expect(h.getFileStream).not.toHaveBeenCalled();
    expect(h.invokeText).not.toHaveBeenCalled();
  });

  it("answers a cross-tenant id and an absent id identically, so the refusal is not an existence oracle", async () => {
    const cross = await makeAi(CROSS_TENANT_ENVELOPE_ID)
      .service.summarizeDocument(CALLER_ORG, CROSS_TENANT_ENVELOPE_ID, "u1", allRead(), CALLER_MEMBERSHIP)
      .catch((e: unknown) => e);
    const absent = await makeAi(ABSENT_ENVELOPE_ID)
      .service.summarizeDocument(CALLER_ORG, ABSENT_ENVELOPE_ID, "u1", allRead(), CALLER_MEMBERSHIP)
      .catch((e: unknown) => e);
    expect((cross as NotFoundException).getResponse()).toEqual((absent as NotFoundException).getResponse());
  });

  it("takes the scope as a required argument, so an unscoped summarize is unrepresentable", () => {
    expect(SignAiService.prototype.summarizeDocument.length).toBe(5);
  });

  it("the controller resolves sign:envelope:view — the route's own key is the same one, but the scope must be read, not assumed", async () => {
    const service = { summarizeDocument: jest.fn().mockResolvedValue({ summary: "" }) } as unknown as SignAiService;
    const access = { scopeFor: jest.fn().mockResolvedValue("own") } as unknown as AccessService;
    const user = {
      orgId: CALLER_ORG,
      userId: "user-other",
      isOrgOwner: false,
      principal: { kind: "human-session", membershipId: OTHER_MEMBERSHIP, isOrgOwner: false },
    } as unknown as CurrentUserContext;

    await new SignAiController(service, access).summarize(OWN_ENVELOPE_ID, user);

    expect(access.scopeFor).toHaveBeenCalledWith(expect.anything(), "sign:envelope:view");
    const [orgId, envelopeId, userId, read, membershipId] =
      (service.summarizeDocument as jest.Mock).mock.calls[0];
    expect(orgId).toBe(CALLER_ORG);
    expect(envelopeId).toBe(OWN_ENVELOPE_ID);
    expect(userId).toBe("user-other");
    expect(read.unrestricted).toBe(false);
    expect(membershipId).toBe(OTHER_MEMBERSHIP);
  });
});

/* ------------------------------------------------------------------ *
 * E2 — POST /sign/admin/run-{reminder,expiration}-sweep
 * ------------------------------------------------------------------ */

describe("E2 · the admin sweeps carry a tenant predicate of their own", () => {
  interface SweepHarness {
    service: SignEnvelopeSweepsService;
    /** The `where` handed to `signEnvelopes.findMany` — the candidate selection. */
    candidateWhere: () => SQL | undefined;
    /** Every `where` handed to an `update()` builder, in call order. */
    updateWheres: SQL[];
    executed: SQL[];
    sendReminder: jest.Mock;
    listForEnvelope: jest.Mock;
  }

  const ownEnvelopeRow = {
    id: OWN_ENVELOPE_ID,
    orgId: CALLER_ORG,
    status: "sent",
    reminderEnabled: true,
    reminderSentCount: 0,
    reminderMaxCount: 3,
    reminderFirstAfterDays: 1,
    reminderRepeatDays: 1,
    lastReminderAt: null,
    sentAt: new Date("2020-01-01T00:00:00Z"),
    expiresAt: new Date("2020-02-01T00:00:00Z"),
    senderMembershipId: CALLER_MEMBERSHIP,
    title: "Own envelope",
  };
  const future = new Date(Date.now() + 86_400_000);
  const past = new Date(Date.now() - 86_400_000);

  function makeSweeps(candidates: (typeof ownEnvelopeRow)[]): SweepHarness {
    let captured: SQL | undefined;
    const updateWheres: SQL[] = [];
    const executed: SQL[] = [];
    const envelopeFindMany = jest.fn((args: { where?: SQL }) => {
      captured = args.where;
      return Promise.resolve(candidates);
    });
    const update = jest.fn(() => ({
      set: () => ({
        where: (predicate: SQL) => {
          updateWheres.push(predicate);
          return Promise.resolve([]);
        },
      }),
    }));
    const db = {
      query: {
        signEnvelopes: { findMany: envelopeFindMany },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      update,
      execute: (statement: SQL) => {
        executed.push(statement);
        return Promise.resolve([{ key: 1 }]);
      },
    } as unknown as Db;

    const listForEnvelope = jest.fn().mockResolvedValue([
      {
        id: 1,
        recipientType: "signer",
        status: "invited",
        email: "signer@example.com",
        name: "Signer",
        signingTokenHash: "hash",
      },
    ]);
    const sendReminder = jest.fn();
    const service = new SignEnvelopeSweepsService(
      db,
      { record: jest.fn() } as never,
      { generateSigningToken: () => "raw", hash: (v: string) => `h:${v}`, buildSigningUrl: (t: string) => t } as never,
      { sendReminder } as never,
      { listForEnvelope } as never,
      { emitEnvelopeEvent: jest.fn() } as never,
    );
    return { service, candidateWhere: () => captured, updateWheres, executed, sendReminder, listForEnvelope };
  }

  const envelopeColumns = (orgId: string, expiresAt: Date) =>
    asColumns({ id: OWN_ENVELOPE_ID, orgId, status: "sent", reminderEnabled: true, expiresAt });
  const recipientColumns = (orgId: string) =>
    asColumns({ id: 1, orgId, envelopeId: OWN_ENVELOPE_ID, status: "invited" });

  it("runReminderSweep selects only the caller's own organisation's envelopes", async () => {
    const h = makeSweeps([ownEnvelopeRow]);
    await h.service.runReminderSweep(CALLER_ORG);
    const where = h.candidateWhere();
    expect(matchesPredicate(where, { sign_envelopes: [envelopeColumns(CALLER_ORG, future)] })).toBe(true);
    expect(matchesPredicate(where, { sign_envelopes: [envelopeColumns(OTHER_ORG, future)] })).toBe(false);
  });

  it("runExpirationSweep selects only the caller's own organisation's envelopes", async () => {
    const h = makeSweeps([]);
    await h.service.runExpirationSweep(CALLER_ORG);
    const where = h.candidateWhere();
    expect(matchesPredicate(where, { sign_envelopes: [envelopeColumns(CALLER_ORG, past)] })).toBe(true);
    expect(matchesPredicate(where, { sign_envelopes: [envelopeColumns(OTHER_ORG, past)] })).toBe(false);
  });

  it("runExpirationSweep binds the recipient revocation and the status write to the same organisation", async () => {
    const expired = { ...ownEnvelopeRow, expiresAt: past };
    const h = makeSweeps([expired]);
    await h.service.runExpirationSweep(CALLER_ORG);
    expect(h.updateWheres).toHaveLength(2);

    expect(matchesPredicate(h.updateWheres[0], { sign_recipients: [recipientColumns(CALLER_ORG)] })).toBe(true);
    expect(matchesPredicate(h.updateWheres[0], { sign_recipients: [recipientColumns(OTHER_ORG)] })).toBe(false);

    expect(matchesPredicate(h.updateWheres[1], { sign_envelopes: [envelopeColumns(CALLER_ORG, past)] })).toBe(true);
    expect(matchesPredicate(h.updateWheres[1], { sign_envelopes: [envelopeColumns(OTHER_ORG, past)] })).toBe(false);
  });

  it("runReminderSweep binds the signing-token rotation to the envelope's own organisation", async () => {
    const h = makeSweeps([ownEnvelopeRow]);
    await h.service.runReminderSweep(CALLER_ORG);
    expect(h.sendReminder).toHaveBeenCalledTimes(1);

    const rendered = h.executed.map((statement) => new PgDialect().sqlToQuery(statement));
    expect(rendered).toHaveLength(1);
    const rotation = rendered[0];
    expect(rotation?.sql).toContain(`"sign_recipients"."org_id" = `);
    expect(rotation?.sql).toContain(`"sign_recipients"."envelope_id" = `);
    expect(rotation?.params).toContain(CALLER_ORG);
    expect(rotation?.params).toContain(OWN_ENVELOPE_ID);
    expect(rotation?.params).not.toContain(OTHER_ORG);

    const reminderCount = h.updateWheres[0];
    expect(matchesPredicate(reminderCount, { sign_envelopes: [envelopeColumns(CALLER_ORG, future)] })).toBe(true);
    expect(matchesPredicate(reminderCount, { sign_envelopes: [envelopeColumns(OTHER_ORG, future)] })).toBe(false);
  });

  it("both sweeps take orgId as a required argument, so an all-organisations run is unrepresentable", () => {
    expect(SignEnvelopeSweepsService.prototype.runReminderSweep.length).toBe(1);
    expect(SignEnvelopeSweepsService.prototype.runExpirationSweep.length).toBe(1);
  });

  it("names the tables the predicates bind, so a schema rename cannot silently void the assertions above", () => {
    expect(signEnvelopes).toBeDefined();
    expect(signRecipients).toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * The public signer-token surface — characterisation, not repair
 * ------------------------------------------------------------------ */

describe("the signer token is bound to one envelope, one recipient, and an expiry", () => {
  const TOKEN = "raw-signing-token";
  const RECIPIENT_ID = 7;
  const OTHER_RECIPIENT_ID = 8;
  const MY_DOCUMENT_ID = 100;
  /** A document id that is real, but attached to a different envelope. */
  const OTHER_ENVELOPE_DOCUMENT_ID = 200;

  const future = new Date(Date.now() + 86_400_000);
  const past = new Date(Date.now() - 86_400_000);

  interface TokenHarness {
    service: SignPublicService;
    getFileUrl: jest.Mock;
    fieldUpdateWheres: SQL[];
  }

  function makePublic(
    recipient: Record<string, unknown> | undefined,
    documents: Record<string, unknown>[],
    fields: Record<string, unknown>[],
  ): TokenHarness {
    const fieldUpdateWheres: SQL[] = [];
    const envelope = {
      id: OWN_ENVELOPE_ID,
      orgId: CALLER_ORG,
      status: "sent",
      title: "Contract",
      senderMembershipId: null,
      allowDecline: true,
      expiresAt: future,
    };
    const db = {
      /**
       * Both `withPublicToken` and `withTenant` open a real transaction and set
       * their GUC through `tx.execute`, so the stub has to answer it — and it
       * hands back the SAME object, which is what the tenant-aware proxy does
       * in production when a request already holds a transaction.
       */
      transaction: (fn: (tx: unknown) => unknown) => fn(txStub),
      execute: jest.fn().mockResolvedValue([]),
      query: {
        signRecipients: { findFirst: jest.fn(() => Promise.resolve(recipient)) },
        signEnvelopes: { findFirst: jest.fn(() => Promise.resolve(envelope)) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(undefined) },
        signDocuments: {
          findMany: jest.fn(() => Promise.resolve(documents)),
          findFirst: jest.fn(({ where }: { where: SQL }) =>
            Promise.resolve(
              documents.find((d) => matchesPredicate(where, { sign_documents: [asColumns(d)] })) ?? undefined,
            ),
          ),
        },
        signFields: {
          findMany: jest.fn(() => Promise.resolve(fields)),
          findFirst: jest.fn(({ where }: { where: SQL }) =>
            Promise.resolve(
              fields.find((f) => matchesPredicate(where, { sign_fields: [asColumns(f)] })) ?? undefined,
            ),
          ),
        },
      },
      update: jest.fn(() => ({
        set: () => ({
          where: (predicate: SQL) => {
            fieldUpdateWheres.push(predicate);
            return Promise.resolve([]);
          },
        }),
      })),
    } as unknown as Db;
    const txStub = db;

    const getFileUrl = jest.fn().mockResolvedValue("https://signed.example/url");
    const service = new SignPublicService(
      db,
      { getFileUrl } as never,
      { record: jest.fn() } as never,
      { hash: (v: string) => `h:${v}` } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, getFileUrl, fieldUpdateWheres };
  }

  const activeRecipient = {
    id: RECIPIENT_ID,
    orgId: CALLER_ORG,
    envelopeId: OWN_ENVELOPE_ID,
    name: "Signer",
    email: "signer@example.com",
    status: "authenticated",
    authMethod: "email_link",
    authenticatedAt: new Date(),
    consentAcceptedAt: new Date(),
    viewedAt: new Date(),
    tokenExpiresAt: future,
    tokenRevokedAt: null,
    failedAuthAttempts: 0,
    authLockedUntil: null,
  };

  const myDocument = { id: MY_DOCUMENT_ID, envelopeId: OWN_ENVELOPE_ID, currentFileKey: "k", fileName: "a.pdf", pageCount: 1 };
  const otherEnvelopeDocument = {
    id: OTHER_ENVELOPE_DOCUMENT_ID,
    envelopeId: 555,
    currentFileKey: "other-key",
    fileName: "b.pdf",
    pageCount: 1,
  };

  it("an unknown token is a 404, so a signing link cannot be enumerated into a session", async () => {
    const h = makePublic(undefined, [], []);
    await expect(h.service.getSession(TOKEN, {})).rejects.toThrow(NotFoundException);
  });

  it("previews a document that belongs to the token's own envelope", async () => {
    const h = makePublic(activeRecipient, [myDocument, otherEnvelopeDocument], []);
    await expect(h.service.getDocumentPreview(TOKEN, MY_DOCUMENT_ID)).resolves.toMatchObject({
      url: "https://signed.example/url",
    });
  });

  it("refuses a document id from a DIFFERENT envelope and mints no signed URL for it", async () => {
    const h = makePublic(activeRecipient, [myDocument, otherEnvelopeDocument], []);
    await expect(h.service.getDocumentPreview(TOKEN, OTHER_ENVELOPE_DOCUMENT_ID)).rejects.toThrow(NotFoundException);
    expect(h.getFileUrl).not.toHaveBeenCalled();
  });

  it("refuses to write a field belonging to a different recipient of the same envelope", async () => {
    const myField = { id: 1, recipientId: RECIPIENT_ID, fieldType: "text", readonly: false, optionsJson: null };
    const theirField = { id: 2, recipientId: OTHER_RECIPIENT_ID, fieldType: "text", readonly: false, optionsJson: null };
    const h = makePublic(activeRecipient, [], [myField, theirField]);
    await expect(h.service.setFieldValue(TOKEN, 2, { value: "x" } as never)).rejects.toThrow(NotFoundException);
    expect(h.fieldUpdateWheres).toHaveLength(0);
  });

  it("an expired tokenExpiresAt closes the session and returns no documents or fields", async () => {
    const h = makePublic({ ...activeRecipient, tokenExpiresAt: past }, [myDocument], []);
    const session = await h.service.getSession(TOKEN, {});
    expect(session).toMatchObject({ state: "expired" });
    expect(session).not.toHaveProperty("documents");
  });

  it("an expired token cannot mint a document URL", async () => {
    const h = makePublic({ ...activeRecipient, tokenExpiresAt: past }, [myDocument], []);
    await expect(h.service.getDocumentPreview(TOKEN, MY_DOCUMENT_ID)).rejects.toThrow(ForbiddenException);
    expect(h.getFileUrl).not.toHaveBeenCalled();
  });

  it("a revoked token closes the session even while tokenExpiresAt is still in the future", async () => {
    const h = makePublic({ ...activeRecipient, tokenRevokedAt: new Date() }, [myDocument], []);
    await expect(h.service.getSession(TOKEN, {})).resolves.toMatchObject({ state: "revoked" });
  });

  it("a voided envelope closes the session regardless of the recipient's own state", async () => {
    const h = makePublic({ ...activeRecipient }, [myDocument], []);
    const db = h.service as unknown as { db: { query: { signEnvelopes: { findFirst: jest.Mock } } } };
    db.db.query.signEnvelopes.findFirst.mockResolvedValueOnce({
      id: OWN_ENVELOPE_ID,
      orgId: CALLER_ORG,
      status: "voided",
      title: "Contract",
      senderMembershipId: null,
      expiresAt: future,
    });
    await expect(h.service.getSession(TOKEN, {})).resolves.toMatchObject({ state: "envelope_voided" });
  });
});
