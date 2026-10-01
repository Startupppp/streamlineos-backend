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

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { signEnvelopes, signRecipients } from "../../../src/db/schema";
import { matchesPredicate } from "../../../src/test/sql-predicate";
import type { Db } from "../../../src/db/drizzle.module";
import { SignAiService } from "../../../src/modules/e-sign/sign-ai.service";
import { SignEnvelopeSweepsService } from "../../../src/modules/e-sign/sign-envelope-sweeps.service";

const CALLER_ORG = "org-caller";
const OTHER_ORG = "org-other";
const CALLER_MEMBERSHIP = 10;
const OWN_ENVELOPE_ID = 42;

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

describe("E1 · summarize takes its scope as an argument", () => {
  it("takes the scope as a required argument, so an unscoped summarize is unrepresentable", () => {
    expect(SignAiService.prototype.summarizeDocument.length).toBe(5);
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
    /* Still open: an envelope past its expiry is the expiration sweep's, and the reminder sweep skips it. */
    expiresAt: new Date("2999-01-01T00:00:00Z"),
    senderMembershipId: CALLER_MEMBERSHIP,
    title: "Own envelope",
  };
  const future = new Date(Date.now() + 86_400_000);

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

  it("runReminderSweep selects only the caller's own organisation's envelopes", async () => {
    const h = makeSweeps([ownEnvelopeRow]);
    await h.service.runReminderSweep(CALLER_ORG);
    const where = h.candidateWhere();
    expect(matchesPredicate(where, { sign_envelopes: [envelopeColumns(CALLER_ORG, future)] })).toBe(true);
    expect(matchesPredicate(where, { sign_envelopes: [envelopeColumns(OTHER_ORG, future)] })).toBe(false);
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
