import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { jobPostings, candidateApplications, candidates } from "src/db/schema";
import {
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

describe("[seeded-e2e] Recruitment Golden Path — job, apply, move, hire", () => {
  let seeded: SeededE2eApp;
  let home: SeededFixture;
  let server: unknown;
  let managerToken: string;
  let jobPostingId: number;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();

    home = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("hr")
      .addMember("manager", {
        permissionKeys: ["hr:jobs:create", "hr:candidates:view", "hr:candidates:manage"],
      })
      .build();

    const [job] = await seeded.seedDb
      .insert(jobPostings)
      .values({
        orgId: home.orgId,
        title: "Software Engineer",
        status: "OPEN",
        description: "Test description",
      })
      .returning({ id: jobPostings.id });
    jobPostingId = job?.id ?? 0;

    managerToken = await signSeededToken(
      seeded,
      home.members.manager.userId,
      home.orgId,
    );
  }, 180_000);

  afterAll(async () => {
    if (home) await home.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  it("golden path: job exists, candidate applies, moves to hired", async () => {
    // 1. Candidate applies (Public API)
    const applyResponse = await request(server as never)
      .post(`/careers/apply`)
      .send({
        jobPostingId,
        name: "Alice Candidate",
        email: "alice@example.com",
        consent: true,
      });

    expect(applyResponse.status).toBe(201);
    const candidateId = applyResponse.body.id;

    // 2. Manager moves candidate to Hired
    // This assumes an endpoint exists for moving candidates.
    // Transition through stages: NEW -> SCREENING -> INTERVIEW -> OFFER -> HIRED
    const stages = ["SCREENING", "INTERVIEW", "OFFER", "HIRED"] as const;
    for (const stage of stages) {
      const hireResponse = await request(server as never)
        .patch(`/hr/recruitment/candidates/${candidateId}/stage`)
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ stage });

      expect(hireResponse.status).toBe(200);
    }

    const [application] = await seeded.seedDb
      .select({ status: candidateApplications.status })
      .from(candidateApplications)
      .where(eq(candidateApplications.candidateId, candidateId));

    expect(application?.status).toBe("HIRED");
  });
});
