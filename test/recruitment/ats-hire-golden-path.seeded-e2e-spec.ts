import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  candidateApplications,
  candidateDocumentsVault,
  candidates,
  hrEmployments,
  hrPeople,
  jobBoardPostings,
  jobPostings,
  jobRequisitions,
  organizationPeople,
  organizations,
  outboxEvents,
} from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";
import { StorageService } from "src/modules/storage/storage.service";

/**
 * Headcount → requisition → job → public apply → pipeline → interview →
 * scorecard → offer → the candidate's own Accept → one employee → onboarding.
 *
 * Every step is HTTP against the booted application on a real database under
 * the non-bypassrls app role. Nothing here calls a service directly: the whole
 * point is that the guards, the tenant transaction, the outbox and the
 * after-commit hooks compose when a real request arrives, which a service-level
 * test cannot show.
 *
 * Run with:
 *   pnpm test:e2e:seeded scratch_ats_e2e \
 *     test/recruitment/ats-hire-golden-path.seeded-e2e-spec.ts
 *
 * `pnpm test:e2e` cannot select this file: `jest-e2e.json` ignores
 * `seeded-e2e-spec` by design, because a spec that talks to a real database has
 * to go through `run-seeded-e2e.ts`, which refuses anything but a scratch
 * target and strips every external integration key out of the environment.
 *
 * The recruiter here holds `hr:requisitions:*`, `hr:interviews:*` and
 * `hr:offers:*` — exactly the keys the Recruitment OS sidebar shows links for,
 * and nothing else. If any controller still wanted `hr:employees:*`, every call
 * below would 403.
 */

const RECRUITER_KEYS = [
  "hr:requisitions:view",
  "hr:requisitions:manage",
  "hr:interviews:view",
  "hr:interviews:manage",
  "hr:offers:view",
  "hr:offers:manage",
  "hr:offers:approve",
];

/** A minimal valid PDF: `validateMagicBytes` checks the header. */
const RESUME_BYTES = Buffer.from("%PDF-1.4\n% seeded resume\n");

const CONSENT_QUESTION = {
  id: "q-permit",
  question: "Do you have the right to work in India?",
  type: "YES_NO" as const,
  required: true,
  knockout: true,
  knockoutAnswer: "Yes",
};

describe(`${SEEDED_HARNESS} ATS hire golden path`, () => {
  let seeded: SeededE2eApp;
  let org: SeededFixture;
  let other: SeededFixture;
  let recruiterToken: string;
  let outsiderToken: string;
  let otherOrgToken: string;
  let orgSlug: string;
  let otherSlug: string;

  const api = () => request(seeded.app.getHttpServer());

  /**
   * Carries the response body into the assertion message. A bare
   * `expect(res.status).toBe(201)` on a 400 prints two numbers and nothing
   * about which field the API refused.
   */
  const said = (res: { status: number; body: unknown }) => ({ status: res.status, body: res.body });
  const asRecruiter = () => ({ Authorization: `Bearer ${recruiterToken}` });

  /** Unique per call: `@Idempotent` routes 400 without the header. */
  const idem = () => ({ "Idempotency-Key": randomUUID() });

  let headcountId: number;
  let requisitionId: number;
  let jobId: number;
  let candidateId: number;
  let applicationId: number;
  let trackingToken: string;
  let offerId: number;
  let acceptanceToken: string;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();

    org = await seedOrg(seeded.seedDb)
      .withModules("hr")
      .onPlan("ENTERPRISE")
      .addMember("recruiter", { permissionKeys: RECRUITER_KEYS })
      .addMember("outsider", { permissionKeys: [] })
      .build();
    other = await seedOrg(seeded.seedDb)
      .withModules("hr")
      .onPlan("ENTERPRISE")
      .addMember("recruiter", { permissionKeys: RECRUITER_KEYS })
      .build();

    recruiterToken = await signSeededToken(seeded, org.members.recruiter!.userId, org.orgId);
    outsiderToken = await signSeededToken(seeded, org.members.outsider!.userId, org.orgId);
    otherOrgToken = await signSeededToken(
      seeded,
      other.members.recruiter!.userId,
      other.orgId,
    );

    const [a] = await seeded.seedDb
      .select({ slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, org.orgId));
    const [b] = await seeded.seedDb
      .select({ slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, other.orgId));
    orgSlug = a!.slug!;
    otherSlug = b!.slug!;
  }, 300_000);

  afterAll(async () => {
    await org?.teardown();
    await other?.teardown();
    await seeded?.close();
  }, 120_000);

  const outboxFor = async (eventType: string) =>
    seeded.seedDb
      .select({ id: outboxEvents.eventId, payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(
        and(eq(outboxEvents.organizationId, org.orgId), eq(outboxEvents.eventType, eventType)),
      );

  // ── 1. the seat ───────────────────────────────────────────────────────────

  it("approves a headcount request, then a requisition linked to it", async () => {
    const created = await api()
      .post("/hr/recruitment/headcount")
      .set(asRecruiter())
      .send({ requestedRole: "Backend Engineer", status: "SUBMITTED", justification: "growth" });
    expect(created.status).toBe(201);
    headcountId = created.body.id as number;

    const approved = await api()
      .post(`/hr/recruitment/headcount/${headcountId}/approve`)
      .set({ ...asRecruiter(), ...idem() });
    expect(approved.status).toBe(201);
    expect(approved.body.status).toBe("APPROVED");

    const requisition = await api()
      .post("/hr/recruitment/requisitions")
      .set(asRecruiter())
      .send({ title: "Backend Engineer", headcount: 1, headcountId, type: "FULL_TIME" });
    expect(requisition.status).toBe(201);
    requisitionId = requisition.body.id as number;
    expect(requisition.body.status).toBe("DRAFT");

    const submitted = await api()
      .patch(`/hr/recruitment/requisitions/${requisitionId}/submit`)
      .set({ ...asRecruiter(), ...idem() });
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe("PENDING_APPROVAL");

    const requisitionApproved = await api()
      .patch(`/hr/recruitment/requisitions/${requisitionId}/approve`)
      .set({ ...asRecruiter(), ...idem() });
    expect(requisitionApproved.status).toBe(200);
    expect(requisitionApproved.body.status).toBe("APPROVED");
  });

  /** Section F: submit/approve/reject used to overwrite the status from anywhere. */
  it("refuses to re-submit or re-approve the requisition it already approved", async () => {
    const resubmit = await api()
      .patch(`/hr/recruitment/requisitions/${requisitionId}/submit`)
      .set({ ...asRecruiter(), ...idem() });
    expect(resubmit.status).toBe(422);

    const reapprove = await api()
      .patch(`/hr/recruitment/requisitions/${requisitionId}/approve`)
      .set({ ...asRecruiter(), ...idem() });
    expect(reapprove.status).toBe(422);
  });

  it("turns the approved requisition into exactly one job, and opens it", async () => {
    const job = await api()
      .post(`/hr/recruitment/requisitions/${requisitionId}/create-job`)
      .set(asRecruiter());
    expect(job.status).toBe(201);
    jobId = job.body.jobId as number;

    const second = await api()
      .post(`/hr/recruitment/requisitions/${requisitionId}/create-job`)
      .set(asRecruiter());
    expect(second.status).toBe(409);

    const opened = await api()
      .patch(`/hr/recruitment/jobs/${jobId}`)
      .set(asRecruiter())
      .send({ status: "OPEN", screeningQuestions: [CONSENT_QUESTION] });
    expect(said(opened)).toMatchObject({ status: 200 });

    const [row] = await seeded.seedDb
      .select({ status: jobPostings.status, openings: jobPostings.openings })
      .from(jobPostings)
      .where(and(eq(jobPostings.id, jobId), eq(jobPostings.orgId, org.orgId)));
    expect(row!.status).toBe("OPEN");
    expect(row!.openings).toBe(1);
  });

  /** Section G: no board was contacted, so nothing may say otherwise. */
  it("reports every board as BLOCKED, queues nothing, and writes no posting row that claims to be live", async () => {
    const published = await api()
      .post(`/hr/recruitment/jobs/${jobId}/publish`)
      .set({ ...asRecruiter(), ...idem() })
      .send({ platforms: ["LINKEDIN"] });
    expect(said(published)).toMatchObject({ status: 201 });
    expect(JSON.stringify(published.body)).not.toContain("PUBLISHED");
    expect(published.body.queuedCount).toBe(0);
    expect(published.body.blockedCount).toBe(1);
    expect(published.body.results[0]).toMatchObject({ status: "BLOCKED", code: "no-integration" });

    const [row] = await seeded.seedDb
      .select({ externalPostingIds: jobPostings.externalPostingIds })
      .from(jobPostings)
      .where(and(eq(jobPostings.id, jobId), eq(jobPostings.orgId, org.orgId)));
    expect(row?.externalPostingIds ?? null).toBeNull();

    /**
     * The publication row exists so the board settings screen can explain the
     * blockage — but it is BLOCKED, holds no posting id, and no outbox event
     * was written, because there is no work anybody could do.
     */
    const publications = await seeded.seedDb
      .select({
        status: jobBoardPostings.status,
        statusDetail: jobBoardPostings.statusDetail,
        externalPostingId: jobBoardPostings.externalPostingId,
      })
      .from(jobBoardPostings)
      .where(and(eq(jobBoardPostings.orgId, org.orgId), eq(jobBoardPostings.jobPostingId, jobId)));
    expect(publications).toHaveLength(1);
    expect(publications[0]).toMatchObject({ status: "BLOCKED", externalPostingId: null });
    expect(publications[0]!.statusDetail).toContain("no-integration");

    const queued = await outboxFor("job.board.publish_requested");
    expect(queued).toHaveLength(0);
  });

  // ── 2. the application ────────────────────────────────────────────────────

  it("refuses an application with no consent, and one that answers a knockout wrongly", async () => {
    const noConsent = await api()
      .post(`/public/careers/${orgSlug}/jobs/${jobId}/apply`)
      .send({ name: "No Consent", email: "no-consent@test.invalid" });
    expect(noConsent.status).toBe(400);

    const knockedOut = await api()
      .post(`/public/careers/${orgSlug}/jobs/${jobId}/apply`)
      .send({
        name: "Knocked Out",
        email: "knocked-out@test.invalid",
        consent: true,
        answers: { [CONSENT_QUESTION.id]: "No" },
      });
    expect(knockedOut.status).toBe(422);

    const rows = await seeded.seedDb
      .select({ id: candidates.id })
      .from(candidates)
      .where(eq(candidates.orgId, org.orgId));
    expect(rows).toHaveLength(0);
  });

  it("accepts an application with consent, a screening answer and a résumé", async () => {
    /**
     * Object storage is deliberately absent from the seeded environment —
     * `assertSeededProcessIsolation` refuses every `*_ACCESS_KEY`. Spying on the
     * real methods keeps the signatures honest while letting the vault write be
     * exercised; what is proved here is that OUR code stores the key and links
     * it, not that S3 works.
     */
    const storage = seeded.app.get(StorageService);
    const configured = jest.spyOn(storage, "isConfigured").mockReturnValue(true);
    const planned = jest
      .spyOn(storage, "planUpload")
      .mockResolvedValue({ key: `${org.orgId}/candidates/resumes/cv.pdf`, plannedMimeType: "application/pdf" });
    const uploaded = jest.spyOn(storage, "uploadToKey").mockResolvedValue(undefined);

    try {
      const applied = await api()
        .post(`/public/careers/${orgSlug}/jobs/${jobId}/apply`)
        .field("name", "Asha Mehta")
        .field("email", "Asha.Mehta@test.invalid")
        .field("consent", "true")
        .field("answers", JSON.stringify({ [CONSENT_QUESTION.id]: "Yes" }))
        .attach("resume", RESUME_BYTES, { filename: "cv.pdf", contentType: "application/pdf" });

      expect(said(applied)).toMatchObject({
        status: 201,
        body: { duplicate: false, resumeStored: true, resumeReason: null },
      });
      trackingToken = applied.body.trackingToken as string;
      expect(uploaded).toHaveBeenCalled();
    } finally {
      configured.mockRestore();
      planned.mockRestore();
      uploaded.mockRestore();
    }

    const [candidate] = await seeded.seedDb
      .select({ id: candidates.id, email: candidates.email, status: candidates.status })
      .from(candidates)
      .where(eq(candidates.orgId, org.orgId));
    expect(candidate).toBeDefined();
    candidateId = candidate!.id;
    expect(candidate!.email).toBe("asha.mehta@test.invalid");
    expect(candidate!.status).toBe("NEW");

    const [application] = await seeded.seedDb
      .select({
        id: candidateApplications.id,
        status: candidateApplications.status,
        consentAt: candidateApplications.consentAt,
        screeningAnswers: candidateApplications.screeningAnswers,
      })
      .from(candidateApplications)
      .where(eq(candidateApplications.orgId, org.orgId));
    applicationId = application!.id;
    expect(application!.consentAt).toBeInstanceOf(Date);
    expect(application!.screeningAnswers).toEqual({ [CONSENT_QUESTION.id]: "Yes" });
    expect(application!.status).toBe("APPLIED");

    const vault = await seeded.seedDb
      .select({ s3Key: candidateDocumentsVault.s3Key, avResult: candidateDocumentsVault.avResult })
      .from(candidateDocumentsVault)
      .where(eq(candidateDocumentsVault.orgId, org.orgId));
    expect(vault).toHaveLength(1);
    expect(vault[0]!.s3Key).toContain("candidates/resumes");

    expect(await outboxFor("candidate.applied")).toHaveLength(1);
  });

  it("answers a second application from the same email with the first tracking token", async () => {
    const again = await api()
      .post(`/public/careers/${orgSlug}/jobs/${jobId}/apply`)
      .send({
        name: "Asha Mehta",
        email: "asha.mehta@test.invalid",
        consent: true,
        answers: { [CONSENT_QUESTION.id]: "Yes" },
      });
    expect(said(again)).toMatchObject({ status: 201 });
    expect(again.body.duplicate).toBe(true);
    expect(again.body.trackingToken).toBe(trackingToken);

    const applications = await seeded.seedDb
      .select({ id: candidateApplications.id })
      .from(candidateApplications)
      .where(eq(candidateApplications.orgId, org.orgId));
    expect(applications).toHaveLength(1);
    expect(await outboxFor("candidate.applied")).toHaveLength(1);
  });

  // ── 3. the pipeline ───────────────────────────────────────────────────────

  it("carries the application and an event with every stage move", async () => {
    for (const [stage, applicationStatus] of [
      ["SCREENING", "SHORTLISTED"],
      ["INTERVIEW", "INTERVIEWING"],
      ["OFFER", "OFFERED"],
    ] as const) {
      const moved = await api()
        .patch(`/hr/recruitment/candidates/${candidateId}/stage`)
        .set(asRecruiter())
        .send({ stage });
      expect(moved.status).toBe(200);

      const [application] = await seeded.seedDb
        .select({ status: candidateApplications.status })
        .from(candidateApplications)
        .where(eq(candidateApplications.id, applicationId));
      expect(application!.status).toBe(applicationStatus);
    }

    expect(await outboxFor("candidate.moved")).toHaveLength(3);

    const status = await api().get(`/public/application-status/${trackingToken}`);
    expect(status.status).toBe(200);
    expect(status.body.status).toBe("OFFERED");
  });

  it("refuses a stage move the map forbids, and writes nothing", async () => {
    const before = await outboxFor("candidate.moved");
    const illegal = await api()
      .patch(`/hr/recruitment/candidates/${candidateId}/stage`)
      .set(asRecruiter())
      .send({ stage: "NEW" });
    expect(illegal.status).toBe(422);
    expect(await outboxFor("candidate.moved")).toHaveLength(before.length);
  });

  // ── 4. interview and scorecard ────────────────────────────────────────────

  it("schedules an interview and records a scorecard", async () => {
    const scheduled = await api()
      .post("/hr/recruitment/interviews/schedule")
      .set(asRecruiter())
      .send({
        candidateId,
        jobPostingId: jobId,
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
        durationMinutes: 45,
        format: "VIDEO",
        meetLink: "https://meet.example.invalid/seeded",
        interviewers: [org.members.recruiter!.userId],
      });
    expect(said(scheduled)).toMatchObject({ status: 201 });
    const interviewId = (scheduled.body.id ?? scheduled.body.interview?.id) as number;
    expect(interviewId).toBeDefined();

    const scorecard = await api()
      .post(`/hr/recruitment/interviews/${interviewId}/scorecard`)
      .set(asRecruiter())
      .send({ ratings: { communication: 8, depth: 9 }, recommendation: "HIRE", notes: "Strong" });
    expect(said(scorecard)).toMatchObject({ status: 201 });
  });

  // ── 5. the offer ──────────────────────────────────────────────────────────

  it("approves the offer, which mints the token and fires offer.sent", async () => {
    const created = await api()
      .post(`/hr/recruitment/candidates/${candidateId}/offers`)
      .set(asRecruiter())
      .send({
        jobPostingId: jobId,
        offeredSalary: 120000,
        offeredDesignation: "Backend Engineer",
        joiningDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
      });
    expect(said(created)).toMatchObject({ status: 201 });
    offerId = created.body.id as number;

    const submitted = await api()
      .post(`/hr/recruitment/candidates/${candidateId}/offers/${offerId}/submit-for-approval`)
      .set({ ...asRecruiter(), ...idem() });
    expect(said(submitted)).toMatchObject({ status: 201 });

    const approved = await api()
      .post(`/hr/recruitment/candidates/${candidateId}/offers/${offerId}/approve`)
      .set({ ...asRecruiter(), ...idem() })
      .send({ remarks: "approved" });
    expect(said(approved)).toMatchObject({ status: 201 });

    const offers = await api()
      .get(`/hr/recruitment/candidates/${candidateId}/offers`)
      .set(asRecruiter());
    const offer = offers.body.find((o: { id: number }) => o.id === offerId);
    expect(offer.offerStatus).toBe("SENT");
    expect(offer.acceptanceToken).toBeTruthy();
    acceptanceToken = offer.acceptanceToken as string;
  });

  // ── 6. the candidate accepts ──────────────────────────────────────────────

  it("hires the candidate from the public offer link", async () => {
    const accepted = await api()
      .patch(`/public/offer/${acceptanceToken}/respond`)
      .send({ action: "accept" });
    expect(said(accepted)).toMatchObject({ status: 200 });
    expect(accepted.body.status).toBe("ACCEPTED");

    // After-commit hooks run in their own transactions once the response is out.
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const [candidate] = await seeded.seedDb
      .select({ status: candidates.status })
      .from(candidates)
      .where(eq(candidates.id, candidateId));
    expect(candidate!.status).toBe("HIRED");

    const [application] = await seeded.seedDb
      .select({ status: candidateApplications.status })
      .from(candidateApplications)
      .where(eq(candidateApplications.id, applicationId));
    expect(application!.status).toBe("ACCEPTED");

    const [job] = await seeded.seedDb
      .select({ openings: jobPostings.openings, status: jobPostings.status })
      .from(jobPostings)
      .where(eq(jobPostings.id, jobId));
    expect(job!.openings).toBe(0);
    expect(job!.status).toBe("FILLED");

    const [requisition] = await seeded.seedDb
      .select({ status: jobRequisitions.status })
      .from(jobRequisitions)
      .where(eq(jobRequisitions.id, requisitionId));
    expect(requisition!.status).toBe("FILLED");

    expect(await outboxFor("candidate.hired")).toHaveLength(1);
    expect(await outboxFor("hire.handoff")).toHaveLength(1);

    const status = await api().get(`/public/application-status/${trackingToken}`);
    expect(status.body.status).toBe("ACCEPTED");
  });

  it("creates exactly one person and one pre-joining employment, with the offer's salary", async () => {
    const people = await seeded.seedDb
      .select({ id: organizationPeople.organizationPersonId, email: organizationPeople.workEmail })
      .from(organizationPeople)
      .where(
        and(
          eq(organizationPeople.organizationId, org.orgId),
          eq(organizationPeople.workEmail, "asha.mehta@test.invalid"),
          isNull(organizationPeople.deletedAt),
        ),
      );
    expect(people).toHaveLength(1);

    const hrPeopleRows = await seeded.seedDb
      .select({ id: hrPeople.id })
      .from(hrPeople)
      .where(and(eq(hrPeople.orgId, org.orgId), isNull(hrPeople.deletedAt)));
    expect(hrPeopleRows).toHaveLength(1);

    const employments = await seeded.seedDb
      .select({
        id: hrEmployments.id,
        employeeNumber: hrEmployments.employeeNumber,
        lifecycleStatus: hrEmployments.lifecycleStatus,
      })
      .from(hrEmployments)
      .where(
        and(
          eq(hrEmployments.orgId, org.orgId),
          eq(hrEmployments.isPrimary, true),
          isNull(hrEmployments.deletedAt),
        ),
      );
    expect(employments).toHaveLength(1);
    expect(employments[0]!.employeeNumber).toBe(`CAND-${candidateId}`);

    /**
     * The employment is created at `PRE_JOINING` and `OnboardingInitiationService`
     * moves it to `ONBOARDING` — both are pre-joining states and neither is
     * `ACTIVE`. Which one is visible depends on whether onboarding started, so
     * the durable proof of BOTH facts is the transition itself, asserted in the
     * next case.
     */
    expect(["PRE_JOINING", "ONBOARDING"]).toContain(employments[0]!.lifecycleStatus);
  });

  it("starts onboarding through the existing service, not by inserting tasks", async () => {
    const employmentRows = await seeded.seedDb.execute<{
      from_status: string;
      to_status: string;
    }>(
      `SELECT h.from_status, h.to_status
         FROM hr_employment_history h
         JOIN hr_employments e ON e.id = h.employment_id
        WHERE h.org_id = '${org.orgId}'
          AND h.to_status = 'ONBOARDING'` as never,
    );
    const tasks = await seeded.seedDb.execute<{ count: string }>(
      `SELECT count(*)::text AS count FROM onboarding_tasks WHERE org_id = '${org.orgId}'` as never,
    );

    /**
     * Onboarding CAN legitimately fail to start — a full member seat, a refused
     * email domain — and the acceptance path audits that rather than claiming
     * success. This fixture is on ENTERPRISE with an unrestricted domain, so it
     * must start; the audit read exists to put the reason in the failure
     * message instead of leaving a bare `0 > 0`.
     */
    const started = Number(tasks[0]?.count ?? "0") > 0;
    if (!started) {
      const audits = await seeded.seedDb.execute<{ action: string; metadata: unknown }>(
        `SELECT action, metadata FROM audit_logs
          WHERE org_id = '${org.orgId}' AND action = 'HIRE_ONBOARDING_NOT_STARTED'` as never,
      );
      throw new Error(`onboarding did not start: ${JSON.stringify(audits)}`);
    }
    /** The lifecycle moved PRE_JOINING → ONBOARDING through the real service. */
    expect(employmentRows.length).toBeGreaterThan(0);
  });

  it("does not create a second person when the offer is accepted again", async () => {
    const replay = await api()
      .patch(`/public/offer/${acceptanceToken}/respond`)
      .send({ action: "accept" });
    expect(replay.status).toBe(409);

    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const hrPeopleRows = await seeded.seedDb
      .select({ id: hrPeople.id })
      .from(hrPeople)
      .where(and(eq(hrPeople.orgId, org.orgId), isNull(hrPeople.deletedAt)));
    expect(hrPeopleRows).toHaveLength(1);

    const [job] = await seeded.seedDb
      .select({ openings: jobPostings.openings })
      .from(jobPostings)
      .where(eq(jobPostings.id, jobId));
    expect(job!.openings).toBe(0);

    expect(await outboxFor("candidate.hired")).toHaveLength(1);
  });

  // ── 7. the negatives ──────────────────────────────────────────────────────

  it("404s every id of this org for the other org's recruiter", async () => {
    const otherHeaders = { Authorization: `Bearer ${otherOrgToken}` };

    expect((await api().get(`/hr/recruitment/jobs/${jobId}`).set(otherHeaders)).status).toBe(404);
    expect(
      (await api().get(`/hr/recruitment/candidates/${candidateId}`).set(otherHeaders)).status,
    ).toBe(404);
    expect(
      (
        await api()
          .get(`/hr/recruitment/candidates/${candidateId}/offers`)
          .set(otherHeaders)
      ).status,
    ).toBe(404);
    expect(
      (await api().get(`/public/careers/${otherSlug}/jobs/${jobId}`)).status,
    ).toBe(404);
  });

  /** Section E: the nav key opens the desk, and no HR key closes it. */
  it("lets the nav key reach the desk, and refuses a member who holds none of it", async () => {
    expect((await api().get("/hr/recruitment/jobs").set(asRecruiter())).status).toBe(200);
    expect((await api().get("/hr/recruitment/candidates").set(asRecruiter())).status).toBe(200);
    expect((await api().get("/hr/recruitment/pipeline").set(asRecruiter())).status).toBe(200);

    const denied = { Authorization: `Bearer ${outsiderToken}` };
    expect((await api().get("/hr/recruitment/jobs").set(denied)).status).toBe(403);
    expect((await api().get("/hr/recruitment/candidates").set(denied)).status).toBe(403);
  });

  it("accepts a résumé upload on the corrected key, and refuses it without one", async () => {
    const denied = await api()
      .post(`/hr/recruitment/candidates/${candidateId}/documents/upload`)
      .set({ Authorization: `Bearer ${outsiderToken}` })
      .attach("file", RESUME_BYTES, { filename: "cv.pdf", contentType: "application/pdf" });
    expect(denied.status).toBe(403);

    const storage = seeded.app.get(StorageService);
    const planned = jest
      .spyOn(storage, "planUpload")
      .mockResolvedValue({ key: `${org.orgId}/hr-documents/cv.pdf`, plannedMimeType: "application/pdf" });
    const compressed = jest
      .spyOn(storage, "compressToKey")
      .mockResolvedValue({ size: RESUME_BYTES.length, mimeType: "application/pdf", sha256: "x" });
    const url = jest.spyOn(storage, "getFileUrl").mockResolvedValue("https://signed.example/cv.pdf");
    try {
      const allowed = await api()
        .post(`/hr/recruitment/candidates/${candidateId}/documents/upload`)
        .set(asRecruiter())
        .field("documentType", "RESUME")
        .attach("file", RESUME_BYTES, { filename: "cv.pdf", contentType: "application/pdf" });
      expect(said(allowed)).toMatchObject({ status: 201 });
    } finally {
      planned.mockRestore();
      compressed.mockRestore();
      url.mockRestore();
    }
  });

  it("does not expose the legacy cross-tenant careers list", async () => {
    expect((await api().get("/careers")).status).toBe(404);
    expect(
      (await api().post("/careers/apply").send({ jobPostingId: jobId, name: "x", email: "x@y.z", consent: true }))
        .status,
    ).toBe(404);
  });
});
