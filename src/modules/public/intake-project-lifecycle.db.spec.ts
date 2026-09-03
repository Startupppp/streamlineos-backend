/**
 * `POST /public/intake/:projectId` accepted an anonymous write into a project that had
 * been deleted.
 *
 * THE SHAPE OF THE ROUTE. It is `@Public()`, addressed by a SEQUENTIAL INTEGER, and every
 * one of its five siblings on the same controller — forms, lead-form, nps, vendor-portal,
 * external-referral — is addressed by an unguessable token instead. Migration 0385 records
 * the gap and declines to close it ("that is the app's existing, pre-RLS design"). It is
 * still open, and closing it means changing the address and every deployed intake link
 * with it: a per-project token, a new public route, and the frontend page at
 * `app/(public)/intake/[projectId]`. That is deliberately NOT what this spec is about.
 *
 * WHAT IT IS ABOUT. `app.resolve_project_org_id` is SECURITY DEFINER (`prosecdef = t`,
 * confirmed against the live catalog) and its body is `SELECT org_id FROM build.projects
 * WHERE id = p_project_id` — no lifecycle predicate, by design, because its comment says it
 * exists to return "only the org_id … Never expose any other project column through this
 * path". It resolves the TENANT. HEAD then treated that as the whole decision and inserted,
 * so a soft-deleted project still accepted public submissions and the rows landed in a
 * project whose deletion had already removed everything that would surface them.
 *
 * The row is now re-read inside the tenant transaction, where RLS is live and
 * `app.organization_id` is the org the resolver named. That is the shape the calendar
 * provider webhook already uses for this exact problem: resolve the tenant outside the
 * policy, enforce the predicate against the real row inside it.
 *
 * WHY A REAL DATABASE. Two of the three claims are facts about Postgres and nothing else:
 * that `build.projects` carries `USING (org_id = app.current_org_id())` — which RAISES
 * 42501 rather than returning nothing when the GUC is absent, so a re-read moved outside
 * the transaction would 500 in production and pass a mocked test — and that a soft-deleted
 * row is still visible to the resolver. A double answers whatever it was told.
 *
 *   PUBLIC_DB_TESTS=1 \
 *   APP_DATABASE_URL="postgresql://streamline_app:…@localhost:5432/scratch_head_1010" \
 *   DATABASE_URL="postgresql://tarunchintakunta@localhost:5432/scratch_head_1010" \
 *   PGSSLMODE=disable TZ=Asia/Kolkata \
 *     npx jest --runInBand --testPathPattern="intake-project-lifecycle.db"
 */
import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
// The namespace is what `drizzle(client, { schema })` needs to produce a value of type
// `Db`. No CRM identity table is referenced here — only build.projects and
// build.intake_items, reached through the service under test.
// eslint-disable-next-line no-restricted-imports -- namespace needed for the Db type; no CRM identity table is referenced here
import * as schema from "../../db/schema";
import { createTenantAwareDb } from "../../common/tenant/tenant-db";
import { IntakeService } from "./intake.service";

const ENABLED = process.env.PUBLIC_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;
if (ENABLED) jest.setTimeout(180_000);

const suffix = randomUUID().slice(0, 8);
const ORG = `intake-${suffix}`;
const OWNER = `intake-owner-${suffix}`;
const REFUSAL = "Invalid request";

describeDb("public intake — a deleted project does not accept anonymous submissions", () => {
  let owner: ReturnType<typeof postgres>;
  let appClient: ReturnType<typeof postgres>;
  let service: IntakeService;
  let liveProjectId: number;
  let deletedProjectId: number;

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL;
    const appUrl = process.env.APP_DATABASE_URL;
    if (!ownerUrl || !appUrl)
      throw new Error(
        "PUBLIC_DB_TESTS needs DATABASE_URL (owner, for the seed graph) and APP_DATABASE_URL (the RLS role)",
      );

    owner = postgres(ownerUrl, { prepare: false, max: 2, connect_timeout: 30 });
    appClient = postgres(appUrl, { prepare: false, max: 4, connect_timeout: 30 });
    const base = drizzle(appClient, { schema });

    // The service holds the tenant-aware `DRIZZLE` handle, and a `@Public()` request has no
    // ambient tenant context — so this is the handle shape the route actually runs on, and
    // every read it makes falls through to the raw pool unless it opens a transaction.
    service = new IntakeService(createTenantAwareDb(Object.assign(base, { __client: appClient })));

    await owner.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`
        INSERT INTO users (id, email, name)
        VALUES (${OWNER}, ${`${OWNER}@intake-probe.invalid`}, 'Intake probe owner')`;
      await tx`
        INSERT INTO organizations (id, name, slug, owner_membership_id)
        VALUES (${ORG}, 'Intake probe', ${ORG}, 0)`;
      const [member] = await tx<{ id: number }[]>`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${OWNER}, ${ORG}, 'OWNER', true) RETURNING id`;
      await tx`UPDATE organizations SET owner_membership_id = ${member?.id ?? 0} WHERE id = ${ORG}`;

      // `build.projects` carries a composite FK to the org's PM workspace.
      await tx`
        INSERT INTO build.pm_workspaces (pm_workspace_id, org_id, name, slug, is_default, status)
        VALUES (${`ws-${suffix}`}, ${ORG}, 'Intake probe workspace', ${`ws-${suffix}`}, true, 'active')`;

      const [live] = await tx<{ id: number }[]>`
        INSERT INTO build.projects (org_id, name, key, pm_workspace_id)
        VALUES (${ORG}, 'Live project', ${`LIVE${suffix}`}, ${`ws-${suffix}`}) RETURNING id`;
      const [gone] = await tx<{ id: number }[]>`
        INSERT INTO build.projects (org_id, name, key, pm_workspace_id, deleted_at)
        VALUES (${ORG}, 'Deleted project', ${`GONE${suffix}`}, ${`ws-${suffix}`}, now()) RETURNING id`;
      liveProjectId = Number(live?.id);
      deletedProjectId = Number(gone?.id);
    });
  }, 180_000);

  afterAll(async () => {
    if (owner) {
      await owner`DELETE FROM build.intake_items WHERE org_id = ${ORG}`;
      await owner`DELETE FROM build.projects WHERE org_id = ${ORG}`;
      await owner`DELETE FROM build.pm_workspaces WHERE org_id = ${ORG}`;
      await owner`DELETE FROM organizations WHERE id = ${ORG}`;
      await owner`DELETE FROM users WHERE id = ${OWNER}`;
      await owner.end({ timeout: 5 });
    }
    if (appClient) await appClient.end({ timeout: 5 });
  }, 60_000);

  async function intakeCount(projectId: number): Promise<number> {
    const [row] = await owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM build.intake_items WHERE project_id = ${projectId}`;
    return row?.n ?? 0;
  }

  it("connects as a role RLS actually applies to", async () => {
    // Anti-vacuity: as an owner with rolbypassrls the policy on `build.projects` never runs
    // and the re-read below could not fail for the reason this spec is about.
    const [role] = await appClient<{ rolbypassrls: boolean }[]>`
      SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role?.rolbypassrls).toBe(false);
  });

  it("the resolver still answers for a deleted project — it names the tenant, it does not judge", async () => {
    // The premise. If the resolver itself filtered deleted rows, the service-level guard
    // below would be untestable through this route and this file would prove nothing.
    const [resolved] = await appClient<{ org_id: string | null }[]>`
      SELECT app.resolve_project_org_id(${deletedProjectId}) AS org_id`;
    expect(resolved?.org_id).toBe(ORG);
  });

  it("accepts a submission for a live project", async () => {
    // The control, and it also proves the re-read happens INSIDE a tenant transaction:
    // `build.projects` is `USING (org_id = app.current_org_id())`, and that function raises
    // 42501 rather than returning nothing when the GUC is unset, so the same read issued on
    // the pool would throw here rather than pass.
    const result = await service.submitIntake(liveProjectId, { title: "Login is broken" });

    expect(result).toMatchObject({ message: "Request submitted successfully" });
    expect(typeof result.id).toBe("number");
    expect(await intakeCount(liveProjectId)).toBe(1);
  });

  it("refuses a submission for a soft-deleted project, and writes nothing", async () => {
    await expect(
      service.submitIntake(deletedProjectId, { title: "Filed into a deleted project" }),
    ).rejects.toThrow(BadRequestException);

    expect(await intakeCount(deletedProjectId)).toBe(0);
  });

  it("answers a deleted project and a project that never existed identically", async () => {
    // The refusal must not become a second oracle: an anonymous caller learns the same
    // thing from both, which is nothing.
    const deleted = await service
      .submitIntake(deletedProjectId, { title: "probe" })
      .then(() => null, (error: unknown) => error);
    const absent = await service
      .submitIntake(-1, { title: "probe" })
      .then(() => null, (error: unknown) => error);

    expect(deleted).toBeInstanceOf(BadRequestException);
    expect(absent).toBeInstanceOf(BadRequestException);
    expect(deleted instanceof Error ? deleted.message : "").toBe(REFUSAL);
    expect(absent instanceof Error ? absent.message : "").toBe(REFUSAL);
  });
});
