import request from "supertest";
import { randomBytes, createHash } from "node:crypto";
import { and, desc, eq, like } from "drizzle-orm";
import {
  emailOutbox,
  orgModules,
  signEnvelopes,
  signRecipients,
  signSweepRuns,
} from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * SIGN-P1-05 and SIGN-P1-07.
 *
 * SIGN-P0-01 gave the reminder sweep a scheduler. That proved the sweep runs;
 * it did not prove a reminder reaches anyone. The gap that let the unwired
 * version ship for as long as it did was precisely this — every test stopped at
 * "the sweep returned a count".
 *
 * So this file follows the reminder all the way out and back in. It waits for
 * the interval to elapse, runs the cron, reads the mail that was actually
 * queued, pulls the link out of that mail's HTML, and signs in with it.
 *
 * The link matters more than it looks. `remindEnvelopeRecipients` ROTATES the
 * signing token on every reminder: it mints a new one, overwrites
 * `signing_token_hash`, and mails the new URL. Get that wrong in either
 * direction and the failure is silent — a stale link in the mail body leaves
 * the signer with a dead link and no way to say so, and a rotation that does
 * not take leaves the old link alive after the org believed it superseded. Both
 * are asserted here, in both directions.
 *
 * `state: "active"` rather than a bare 200, because `getSession` answers 200
 * for `expired`, `revoked` and `not_your_turn` as well. Rotation replaces the
 * hash and leaves `token_expires_at` alone, so "the link resolves" and "the
 * link works" are genuinely different questions.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db CRON_SECRET=... \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=sign-reminder-dispatch
 */

const CRON_SECRET = process.env.CRON_SECRET ?? "";
const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe(`${SEEDED_HARNESS} a reminder reaches the signer with a link that works`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;

  /** Due for its first reminder: sent five days ago, first reminder after three. */
  let dueEnvelopeId = 0;
  let dueRecipientId = 0;
  let dueEmail = "";
  let originalToken = "";

  /** Sent today. The same sweep must leave it alone. */
  let freshEnvelopeId = 0;
  let freshEmail = "";

  /** What the dry run said would happen, to be held against what did. */
  let predictedAffected = -1;

  const seedEnvelope = async (opts: {
    title: string;
    sentAt: Date;
    firstAfterDays: number;
  }): Promise<{ envelopeId: number; recipientId: number; email: string; token: string }> => {
    const [envelope] = await seeded.seedDb
      .insert(signEnvelopes)
      .values({
        orgId: fixture.orgId,
        title: opts.title,
        status: "sent",
        senderUserId: fixture.members["sender"]!.userId,
        sentAt: opts.sentAt,
        reminderEnabled: true,
        reminderFirstAfterDays: opts.firstAfterDays,
        reminderRepeatDays: 3,
        reminderMaxCount: 5,
        reminderSentCount: 0,
      })
      .returning({ id: signEnvelopes.id });

    const token = randomBytes(32).toString("hex");
    const email = `signer-${randomBytes(6).toString("hex")}@test.invalid`;
    const [recipient] = await seeded.seedDb
      .insert(signRecipients)
      .values({
        orgId: fixture.orgId,
        envelopeId: envelope!.id,
        roleName: "Signer",
        recipientType: "signer",
        name: "Reminder Probe",
        email,
        routingOrder: 1,
        status: "invited",
        authMethod: "email_link",
        signingTokenHash: hashToken(token),
      })
      .returning({ id: signRecipients.id });

    return { envelopeId: envelope!.id, recipientId: recipient!.id, email, token };
  };

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb).addMember("sender", { permissionKeys: [] }).build();
    await seeded.seedDb
      .insert(orgModules)
      .values({ orgId: fixture.orgId, moduleKey: "sign", enabled: true })
      .onConflictDoNothing();

    const due = await seedEnvelope({ title: "Overdue for a nudge", sentAt: daysAgo(5), firstAfterDays: 3 });
    dueEnvelopeId = due.envelopeId;
    dueRecipientId = due.recipientId;
    dueEmail = due.email;
    originalToken = due.token;

    const fresh = await seedEnvelope({ title: "Only just sent", sentAt: new Date(), firstAfterDays: 3 });
    freshEnvelopeId = fresh.envelopeId;
    freshEmail = fresh.email;
  }, 240_000);

  afterAll(async () => {
    if (fixture) {
      await seeded.seedDb.delete(emailOutbox).where(eq(emailOutbox.organizationId, fixture.orgId));
      await seeded.seedDb.delete(signSweepRuns).where(eq(signSweepRuns.orgId, fixture.orgId));
      await seeded.seedDb.delete(signRecipients).where(eq(signRecipients.orgId, fixture.orgId));
      await seeded.seedDb.delete(signEnvelopes).where(eq(signEnvelopes.orgId, fixture.orgId));
      await fixture.teardown();
    }
    await seeded?.close();
  }, 60_000);

  const runReminderSweep = async (query = "") => {
    const res = await request(seeded.app.getHttpServer())
      .post(`/cron/sign-reminder-sweep${query}`)
      .set("Authorization", `Bearer ${CRON_SECRET}`)
      .send({});
    expect(res.status).toBe(200);
    return res.body;
  };

  const remindersFor = async (email: string) =>
    seeded.seedDb
      .select({ subject: emailOutbox.subject, html: emailOutbox.html, createdAt: emailOutbox.createdAt })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.toEmail, email), like(emailOutbox.subject, "Reminder:%")))
      .orderBy(desc(emailOutbox.createdAt));

  const session = (token: string) =>
    request(seeded.app.getHttpServer()).get(`/public/sign/${token}/session`);

  it("SIGN-P1-01: a dry run predicts the work and performs none of it", async () => {
    /**
     * First, before any live sweep — so "no mail was queued" cannot be
     * satisfied by there having been nothing to send yet.
     */
    const body = await runReminderSweep("?dryRun=true");

    expect(body.dryRun).toBe(true);
    expect(body.message).toContain("dry run, nothing sent");

    /**
     * The count is org-wide across every tenant in the database, so it is not
     * asserted as a literal — the next test holds the live sweep to this exact
     * number instead. Predicting what the run will do is the only property
     * that makes a dry run worth having, and it is a stronger claim than any
     * constant would be.
     */
    expect(body.affected).toBeGreaterThanOrEqual(1);
    predictedAffected = body.affected;

    expect(await remindersFor(dueEmail)).toHaveLength(0);

    const [due] = await seeded.seedDb
      .select({ count: signEnvelopes.reminderSentCount, lastAt: signEnvelopes.lastReminderAt })
      .from(signEnvelopes)
      .where(eq(signEnvelopes.id, dueEnvelopeId));
    expect(due?.count).toBe(0);
    expect(due?.lastAt).toBeNull();

    /** The token is not rotated either: the signer's existing link still works. */
    const stillValid = await session(originalToken);
    expect(stillValid.status).toBe(200);

    /**
     * And no run is recorded. A rehearsal that stamped the clock would silence
     * the "this sweep has not fired" alert with the very act that proves it has
     * not fired.
     */
    const runs = await seeded.seedDb
      .select({ sweep: signSweepRuns.sweep })
      .from(signSweepRuns)
      .where(eq(signSweepRuns.orgId, fixture.orgId));
    expect(runs).toHaveLength(0);
  }, 120_000);

  it("sends nothing before the interval has elapsed", async () => {
    /**
     * Run first, against both envelopes, so the negative is not merely "the
     * sweep has not been called yet". The fresh envelope is inside its
     * three-day window; the due one is past it.
     */
    const body = await runReminderSweep();

    expect(body.dryRun).toBe(false);
    /** SIGN-P1-01: the rehearsal was accurate. */
    expect(body.affected).toBe(predictedAffected);

    expect(await remindersFor(freshEmail)).toHaveLength(0);

    const [fresh] = await seeded.seedDb
      .select({ count: signEnvelopes.reminderSentCount, lastAt: signEnvelopes.lastReminderAt })
      .from(signEnvelopes)
      .where(eq(signEnvelopes.id, freshEnvelopeId));
    expect(fresh?.count).toBe(0);
    expect(fresh?.lastAt).toBeNull();
  }, 120_000);

  it("queues exactly one reminder for the envelope that is due", async () => {
    const mails = await remindersFor(dueEmail);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toBe('Reminder: "Overdue for a nudge" needs your signature');

    const [due] = await seeded.seedDb
      .select({ count: signEnvelopes.reminderSentCount, lastAt: signEnvelopes.lastReminderAt })
      .from(signEnvelopes)
      .where(eq(signEnvelopes.id, dueEnvelopeId));
    expect(due?.count).toBe(1);
    expect(due?.lastAt).not.toBeNull();
  }, 120_000);

  it("carries a signing link that actually opens a session", async () => {
    const [mail] = await remindersFor(dueEmail);

    /**
     * Read out of the rendered mail body, not built from the database. A test
     * that re-derives the URL from `signing_token_hash` would pass even if the
     * template linked somewhere else entirely.
     */
    const match = /\/sign\/([0-9a-f]{64})/.exec(mail!.html);
    expect(match).not.toBeNull();
    const mailedToken = match![1]!;

    const res = await session(mailedToken);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("active");
    expect(res.body.envelope?.title ?? res.body.envelopeTitle).toBe("Overdue for a nudge");
  }, 120_000);

  it("rotates the token, so the link the reminder replaced is dead", async () => {
    const [mail] = await remindersFor(dueEmail);
    const mailedToken = /\/sign\/([0-9a-f]{64})/.exec(mail!.html)![1]!;

    expect(mailedToken).not.toBe(originalToken);

    const res = await session(originalToken);
    expect(res.status).toBe(404);

    /** And the stored hash is the mailed one, not some third value. */
    const [recipient] = await seeded.seedDb
      .select({ hash: signRecipients.signingTokenHash })
      .from(signRecipients)
      .where(eq(signRecipients.id, dueRecipientId));
    expect(recipient?.hash).toBe(hashToken(mailedToken));
  }, 120_000);

  it("does not remind again until the repeat interval has passed", async () => {
    await runReminderSweep();

    expect(await remindersFor(dueEmail)).toHaveLength(1);

    const [due] = await seeded.seedDb
      .select({ count: signEnvelopes.reminderSentCount })
      .from(signEnvelopes)
      .where(eq(signEnvelopes.id, dueEnvelopeId));
    expect(due?.count).toBe(1);
  }, 120_000);

  it("reminds again once the repeat interval has passed, up to the maximum", async () => {
    /**
     * Backdate the last reminder rather than wait three days. The sweep reads
     * `last_reminder_at`, so moving it is the same input the passage of time
     * would produce.
     */
    await seeded.seedDb
      .update(signEnvelopes)
      .set({ lastReminderAt: daysAgo(4) })
      .where(eq(signEnvelopes.id, dueEnvelopeId));

    await runReminderSweep();

    expect(await remindersFor(dueEmail)).toHaveLength(2);

    const [due] = await seeded.seedDb
      .select({ count: signEnvelopes.reminderSentCount })
      .from(signEnvelopes)
      .where(eq(signEnvelopes.id, dueEnvelopeId));
    expect(due?.count).toBe(2);

    /** The maximum is a stop, not a suggestion. */
    await seeded.seedDb
      .update(signEnvelopes)
      .set({ lastReminderAt: daysAgo(4), reminderSentCount: 5, reminderMaxCount: 5 })
      .where(eq(signEnvelopes.id, dueEnvelopeId));

    await runReminderSweep();
    expect(await remindersFor(dueEmail)).toHaveLength(2);
  }, 180_000);
});
