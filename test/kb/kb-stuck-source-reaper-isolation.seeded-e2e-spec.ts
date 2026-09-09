import { and, eq, inArray, sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.types";
import { kbSources } from "src/db/schema";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import {
  KB_SOURCE_STUCK_MESSAGE,
  reapOrgStuckSources,
} from "src/modules/kb/retrieval/kb-stuck-source-reaper.service";
import { KbSourcesService } from "src/modules/kb/wiki/kb-sources.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

const cutoff = new Date("2026-09-01T12:00:00.000Z");
const stale = new Date("2026-09-01T11:59:59.999Z");
const fresh = new Date("2026-09-01T12:00:00.001Z");

describe("[seeded-e2e] KbStuckSourceReaperService tenant isolation", () => {
  let seeded: SeededE2eApp;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
  }, 120_000);

  afterAll(async () => {
    await seeded?.close();
  });

  it.each(["owner", "application"])(
    "reaps only eligible own sources with the %s connection and leaves the other org unchanged",
    async (connection) => {
      const fixtures: SeededFixture[] = [];
      try {
        const own = await seedOrg(seeded.seedDb).build();
        fixtures.push(own);
        const foreign = await seedOrg(seeded.seedDb).build();
        fixtures.push(foreign);
        const entries: Array<typeof kbSources.$inferInsert> = [
          { orgId: own.orgId, title: "own-stale", kind: "note", status: "processing", updatedAt: stale },
          { orgId: foreign.orgId, title: "foreign-stale", kind: "note", status: "processing", updatedAt: stale },
          { orgId: own.orgId, title: "own-fresh", kind: "note", status: "processing", updatedAt: fresh },
          { orgId: own.orgId, title: "own-boundary", kind: "note", status: "processing", updatedAt: cutoff },
          { orgId: own.orgId, title: "own-deleted", kind: "note", status: "processing", updatedAt: stale, deletedAt: stale },
          { orgId: own.orgId, title: "own-ready", kind: "note", status: "ready", updatedAt: stale, chunkCount: 3 },
          { orgId: own.orgId, title: "own-failed", kind: "note", status: "failed", updatedAt: stale, errorMessage: "Previous failure" },
        ];
        const before = await seeded.seedDb.insert(kbSources).values(entries).returning();
        const eligible = before.find((row) => row.title === "own-stale");
        const foreignSource = before.find((row) => row.title === "foreign-stale");
        if (!eligible || !foreignSource) throw new Error("Missing reaper isolation fixtures");
        const ids = before.map((row) => row.id);
        const appDb = seeded.app.get<Db>(DRIZZLE);
        const sources = seeded.app.get(KbSourcesService);
        const readSource = (orgId: string, sourceId: number) =>
          runInNewTenantTransaction(appDb, orgId, () => sources.get(orgId, sourceId));
        await expect(readSource(own.orgId, eligible.id)).resolves.toMatchObject({ status: "processing" });
        await expect(readSource(foreign.orgId, foreignSource.id)).resolves.toMatchObject({ status: "processing" });

        const reap = () => connection === "owner"
          ? seeded.seedDb.transaction(async (tx) => {
              const visible = await tx.select({ id: kbSources.id }).from(kbSources).where(inArray(kbSources.id, ids));
              expect(visible.map((row) => row.id).sort()).toEqual([...ids].sort());
              return reapOrgStuckSources(tx, own.orgId, cutoff);
            })
          : runInNewTenantTransaction(appDb, own.orgId, async (tx) => {
              const roles = await tx.execute(sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`);
              expect(roles[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
              return reapOrgStuckSources(tx, own.orgId, cutoff);
            });

        expect(await reap()).toBe(1);
        await expect(readSource(own.orgId, eligible.id)).resolves.toMatchObject({
          status: "failed",
          errorMessage: KB_SOURCE_STUCK_MESSAGE,
        });
        await expect(readSource(foreign.orgId, foreignSource.id)).resolves.toMatchObject({
          status: "processing",
          errorMessage: null,
        });
        const after = await seeded.seedDb.select().from(kbSources).where(inArray(kbSources.id, ids));
        for (const original of before.filter((row) => row.id !== eligible.id))
          expect(after.find((row) => row.id === original.id)).toEqual(original);
        expect(await reap()).toBe(0);
      } finally {
        for (const fixture of fixtures) {
          await seeded.seedDb.delete(kbSources).where(and(
            eq(kbSources.orgId, fixture.orgId),
            inArray(kbSources.title, ["own-stale", "foreign-stale", "own-fresh", "own-boundary", "own-deleted", "own-ready", "own-failed"]),
          ));
          await fixture.teardown();
        }
      }
    },
    120_000,
  );
});
