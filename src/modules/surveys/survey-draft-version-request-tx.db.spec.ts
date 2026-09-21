/**
 * `POST /surveys` inserts the survey on the request transaction and then writes
 * its first draft version. That draft used to be written through
 * `runInNewTenantTransaction`, which borrows a SECOND pooled connection and opens
 * a second transaction. Postgres checks `fk_survey_versions_survey_id_org` from
 * that second transaction, and the parent row is still uncommitted in the first
 * one, so the insert fails 23503 — or, when every other connection is held by
 * a request doing the same, the second borrow queues behind the request's own
 * connection and the response never arrives. Either way `/surveys/new` never
 * leaves its skeleton, and `duplicate` and the builder's first read fail the
 * same way.
 *
 * A mocked `db` cannot show this: it answers the insert with whatever row it
 * was handed. This runs the real service, inside one ambient tenant transaction
 * exactly as `TenantContextInterceptor` provides it, against a real catalog, and
 * rolls back — the probe organisation is dropped afterwards.
 *
 *   ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *   HR_PROBE_DATABASE_URL=postgres://tarunchintakunta@localhost:5432/streamline_test \
 *     pnpm test:db-specs --testPathPattern="survey-draft-version-request-tx"
 */
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { requireApprovedDatabaseUrl } from "../../test/db-spec-guard";
import * as schema from "../../db/schema";
import { surveyForms, surveyVersions } from "../../db/schema";
import { createTenantAwareDb } from "../../common/tenant/tenant-db";
import { runWithTenantContext } from "../../common/tenant/tenant-context";
import { createProbeOrg, dropProbeOrg, type ProbeOrg } from "../../../test/helpers/probe-org";
import { SurveyVersionService } from "./survey-version.service";

/** Thrown to roll the transaction back once the assertions have run. */
class Rollback extends Error {}

const REQUEST_BUDGET_MS = 5_000;

function connect() {
  const raw = requireApprovedDatabaseUrl({
    spec: "survey-draft-version-request-tx.db.spec.ts",
    vars: ["HR_PROBE_DATABASE_URL", "DATABASE_URL"],
  });
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return postgres(url.toString(), {
    prepare: false,
    max: 2,
    ssl: local ? false : "require",
    connect_timeout: 30,
    onnotice: () => {},
  });
}

function withinBudget<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`createDraftVersion did not answer within ${REQUEST_BUDGET_MS}ms — the request is waiting on itself`)),
      REQUEST_BUDGET_MS,
    );
  });
  return Promise.race([work, budget]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

describe("SurveyVersionService draft versions inside the request transaction", () => {
  let client: ReturnType<typeof connect>;
  let base: ReturnType<typeof drizzle<typeof schema>>;
  let versions: SurveyVersionService;
  let probe: ProbeOrg;

  beforeAll(async () => {
    client = connect();
    base = drizzle(client, { schema });
    versions = new SurveyVersionService(createTenantAwareDb(Object.assign(base, { __client: client })));
    probe = await createProbeOrg(client, "survey-draft-tx");
  }, 60_000);

  afterAll(async () => {
    if (client) {
      if (probe) await dropProbeOrg(client, probe, ["survey_versions", "survey_forms"]);
      await client.end({ timeout: 5 });
    }
  }, 60_000);

  it(
    "writes the first draft of a survey the same request just inserted on that request's transaction, so the builder read sees it before commit and the request answers within budget",
    async () => {
      let draftId: number | undefined;
      let visibleBeforeCommit = false;

      await expect(
        base.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.organization_id', ${probe.orgId}, true)`);
          await runWithTenantContext({ orgId: probe.orgId, audience: "INTERNAL", tx }, async () => {
            const [survey] = await tx
              .insert(surveyForms)
              .values({ orgId: probe.orgId, title: "draft-tx probe", createdBy: probe.userId })
              .returning({ id: surveyForms.id });
            if (!survey) throw new Error("fixture survey was not inserted");

            const created = await withinBudget(versions.createDraftVersion(probe.orgId, survey.id));
            draftId = created.id;

            const draft = await versions.getDraftVersion(probe.orgId, survey.id);
            const seen = await tx.query.surveyVersions.findFirst({
              columns: { id: true, surveyId: true, versionNumber: true },
              where: eq(surveyVersions.id, created.id),
            });
            visibleBeforeCommit = draft.id === created.id && seen?.surveyId === survey.id && seen.versionNumber === 1;
          });
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);

      expect(draftId).toEqual(expect.any(Number));
      expect(visibleBeforeCommit).toBe(true);

      const [{ leaked }] = await client<{ leaked: number }[]>`
        SELECT count(*)::int AS leaked FROM survey_versions WHERE org_id = ${probe.orgId}`;
      expect(leaked).toBe(0);
    },
    30_000,
  );
});
