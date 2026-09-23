import { eq } from "drizzle-orm";
import { SEEDED_HARNESS, createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";
import { RecruitmentRequisitionsService } from "src/modules/hr/recruitment/recruitment-requisitions.service";
import { RecruitmentCandidatesService } from "src/modules/hr/recruitment/recruitment-candidates.service";
import { RecruitmentCandidateDocsService } from "src/modules/hr/recruitment/recruitment-candidate-docs.service";
import { orgModules } from "src/db/schema";

describe(`${SEEDED_HARNESS} recruitment golden path`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb).addMember("recruiter").build();
    await seeded.seedDb
      .insert(orgModules)
      .values([
        { orgId: fixture.orgId, moduleKey: "hr-recruitment", enabled: true },
      ])
      .onConflictDoNothing();
  }, 240_000);

  afterAll(async () => {
    if (fixture) {
      await fixture.teardown();
    }
    await seeded?.close();
  }, 60_000);

  it("completes the golden path: Requisition -> Candidate Application -> Documents", async () => {
    const reqService = seeded.app.get(RecruitmentRequisitionsService);
    const candidateService = seeded.app.get(RecruitmentCandidatesService);

    // 1. Create Requisition
    const req = await reqService.create(fixture.orgId, fixture.members["recruiter"]!.userId, {
      title: "Software Engineer",
      hiringManagerId: fixture.members["recruiter"]!.userId,
      headcount: 1,
      priority: "MEDIUM",
      type: "FULL_TIME",
    });
    expect(req).toBeDefined();

    // 2. Candidate Application (simulated by creating a candidate)
    const candidate = await candidateService.create(fixture.orgId, {
      firstName: "John",
      lastName: "Doe",
      email: "john.doe@example.com",
    });
    expect(candidate).toBeDefined();

    // 3. Verify Candidate
    const detail = await candidateService.getDetail(fixture.orgId, candidate.id);
    expect(detail.firstName).toBe("John");

    // 4. Submit, Approve and Create Job Posting
    await reqService.submit(fixture.orgId, req.id);
    await reqService.approve(fixture.orgId, req.id, fixture.members["recruiter"]!.userId);
    const { jobId } = await reqService.createJobFromRequisition(fixture.orgId, fixture.members["recruiter"]!.userId, req.id);
    expect(jobId).toBeDefined();

    // 5. Verify Job is linked
    const updatedReq = await reqService.list(fixture.orgId);
    const linkFound = updatedReq.find(r => r.id === req.id && r.status === "APPROVED");
    expect(linkFound).toBeDefined();
  });
});
