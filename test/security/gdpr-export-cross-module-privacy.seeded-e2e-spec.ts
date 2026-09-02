import request from "supertest";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * A subject's GDPR export is the most sensitive artifact the platform produces: one
 * file containing every row about a person. This walks the real HTTP stack so the
 * denial is proven by the running app, not by a service double.
 */
describe(`${SEEDED_HARNESS} GDPR export job — cross-module privacy`, () => {
  let seededApp: SeededE2eApp;

  beforeAll(async () => {
    seededApp = await createSeededE2eApp();
  }, 120_000);

  afterAll(async () => {
    await seededApp.close();
  });

  it(
    `${SEEDED_HARNESS} an export job is readable by its subject, by a retention admin, and by nobody else`,
    async () => {
      const orgA = await seedOrg(seededApp.seedDb)
        .withModules("hr")
        .addMember("subject")
        .addMember("bystander")
        .addMember("retentionAdmin", { permissionKeys: ["hr:retention:manage"] })
        .build();
      const orgB = await seedOrg(seededApp.seedDb)
        .withModules("hr")
        .addMember("outsider", { permissionKeys: ["hr:retention:manage"] })
        .build();

      try {
        const subject = orgA.members["subject"];
        const bystander = orgA.members["bystander"];
        const retentionAdmin = orgA.members["retentionAdmin"];
        const outsider = orgB.members["outsider"];
        if (!subject || !bystander || !retentionAdmin || !outsider)
          throw new Error("fixture members missing");

        const server = seededApp.app.getHttpServer();
        const subjectToken = await signSeededToken(seededApp, subject.userId, orgA.orgId);

        const created = await request(server)
          .post("/gdpr/export-async/me")
          .set("Authorization", `Bearer ${subjectToken}`)
          .send({ idempotencyKey: `seeded-${orgA.orgId}` });
        expect({ status: created.status, fixture: orgA.label() }).toMatchObject({ status: 201 });

        const jobId: unknown = created.body?.id;
        if (typeof jobId !== "string") throw new Error(`no job id in response: ${JSON.stringify(created.body)}`);

        const own = await request(server)
          .get(`/gdpr/export-async/${jobId}/status`)
          .set("Authorization", `Bearer ${subjectToken}`);
        expect({ who: "subject", status: own.status }).toMatchObject({ status: 200 });

        const byBystander = await request(server)
          .get(`/gdpr/export-async/${jobId}/status`)
          .set(
            "Authorization",
            `Bearer ${await signSeededToken(seededApp, bystander.userId, orgA.orgId)}`,
          );
        expect({ who: "same-org member without hr:retention:manage", status: byBystander.status }).toMatchObject({
          status: 404,
        });

        // The admin path was inert before S12: the route carried no PermissionGuard, so
        // req.rbacScope was always undefined and isAdmin was always false.
        const byAdmin = await request(server)
          .get(`/gdpr/export-async/${jobId}/status`)
          .set(
            "Authorization",
            `Bearer ${await signSeededToken(seededApp, retentionAdmin.userId, orgA.orgId)}`,
          );
        expect({ who: "same-org hr:retention:manage holder", status: byAdmin.status }).toMatchObject({
          status: 200,
        });

        const byOutsider = await request(server)
          .get(`/gdpr/export-async/${jobId}/status`)
          .set(
            "Authorization",
            `Bearer ${await signSeededToken(seededApp, outsider.userId, orgB.orgId)}`,
          );
        expect({
          who: "other-org hr:retention:manage holder",
          status: byOutsider.status,
          orgA: orgA.label(),
          orgB: orgB.label(),
        }).toMatchObject({ status: 404 });

        const downloadByOutsider = await request(server)
          .get(`/gdpr/export-async/${jobId}/download`)
          .set(
            "Authorization",
            `Bearer ${await signSeededToken(seededApp, outsider.userId, orgB.orgId)}`,
          );
        expect({ who: "other-org download", status: downloadByOutsider.status }).toMatchObject({
          status: 404,
        });
      } finally {
        await Promise.all([orgA.teardown(), orgB.teardown()]);
      }
    },
    120_000,
  );

  it(
    `${SEEDED_HARNESS} an unauthenticated caller cannot reach any export route`,
    async () => {
      const server = seededApp.app.getHttpServer();
      const unauthenticated = await request(server).get(
        "/gdpr/export-async/00000000-0000-4000-8000-000000000000/status",
      );
      expect(unauthenticated.status).toBe(401);
    },
    30_000,
  );
});
