import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import { ancestorWalkQuery } from "./kb-page-tree.service";

const suffix = randomUUID().slice(0, 8);
const ORG = `kbmc-${suffix}`;
const OTHER_ORG = `kbmc-other-${suffix}`;
const USER = `kbmc-user-${suffix}`;

describe("move cycle guard against real Postgres — a recursive CTE is only safe if it terminates on data that is already corrupt", () => {
  let owner: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const id: Record<string, number> = {};

  async function walk(
    orgId: string,
    pageId: number,
    targetParentId: number,
  ): Promise<boolean> {
    const rows = await db.execute(ancestorWalkQuery(orgId, pageId, targetParentId));
    return rows.length > 0;
  }

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL;
    if (!ownerUrl) throw new Error("kb-page-move-cycle.db.spec.ts requires DATABASE_URL");
    owner = postgres(ownerUrl, { prepare: false, max: 2, connect_timeout: 30 });
    db = drizzle(owner, { schema });

    await owner.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`INSERT INTO users (id, email, name) VALUES (${USER}, ${`${USER}@kbmc.invalid`}, 'Move Cycle Seed')`;
      for (const org of [ORG, OTHER_ORG]) {
        await tx`INSERT INTO organizations (id, name, slug, owner_membership_id) VALUES (${org}, ${org}, ${org}, 0)`;
      }
      const memberOf: Record<string, number> = {};
      for (const org of [ORG, OTHER_ORG]) {
        const [member] = await tx<{ id: number }[]>`
          INSERT INTO organization_members (user_id, org_id, role, is_owner)
          VALUES (${USER}, ${org}, 'OWNER', true) RETURNING id`;
        if (!member) throw new Error("seed: membership insert failed");
        memberOf[org] = member.id;
        await tx`UPDATE organizations SET owner_membership_id = ${member.id} WHERE id = ${org}`;
      }

      const page = async (
        org: string,
        title: string,
        parent: number | null,
        deleted: boolean,
      ): Promise<number> => {
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO kb_pages (org_id, title, visibility, status, created_by_id, created_by_membership_id, parent_page_id, deleted_at)
          VALUES (${org}, ${title}, 'org', 'published', ${USER}, ${memberOf[org]}, ${parent}, ${deleted ? new Date().toISOString() : null})
          RETURNING id`;
        if (!row) throw new Error(`seed: page insert failed for ${title}`);
        return row.id;
      };

      id.root = await page(ORG, "root", null, false);
      id.child = await page(ORG, "child", id.root, false);
      id.grandchild = await page(ORG, "grandchild", id.child, false);
      id.unrelated = await page(ORG, "unrelated", null, false);
      id.deletedMiddle = await page(ORG, "deleted middle", id.root, true);
      id.belowDeleted = await page(ORG, "below deleted", id.deletedMiddle, false);
      id.foreign = await page(OTHER_ORG, "foreign root", null, false);
      id.loopA = await page(ORG, "loop a", null, false);
      id.loopB = await page(ORG, "loop b", id.loopA, false);
      await tx`UPDATE kb_pages SET parent_page_id = ${id.loopB} WHERE id = ${id.loopA}`;
    });
  }, 120_000);

  afterAll(async () => {
    if (owner) {
      await owner`UPDATE kb_pages SET parent_page_id = NULL WHERE org_id IN (${ORG}, ${OTHER_ORG})`;
      await owner`DELETE FROM kb_pages WHERE org_id IN (${ORG}, ${OTHER_ORG})`;
      for (const org of [ORG, OTHER_ORG]) {
        await owner.begin(async (tx) => {
          await tx`SELECT set_config('app.audit_log_detachment', 'true', true)`;
          await tx`UPDATE audit_logs SET org_id = null, actor_membership_id = null, is_platform_event = true WHERE org_id = ${org}`;
          await tx`DELETE FROM organizations WHERE id = ${org}`;
        });
      }
      await owner`DELETE FROM users WHERE id = ${USER} AND NOT EXISTS (SELECT 1 FROM audit_logs WHERE user_id = ${USER})`;
      await owner.end({ timeout: 5 });
    }
  }, 120_000);

  it("rejects a move into a direct child, which is the shallowest cycle a caller can ask for", async () => {
    expect(await walk(ORG, id.root, id.child)).toBe(true);
  });

  it("rejects a move into a descendant two levels down, so the walk follows the whole chain rather than checking only the immediate parent", async () => {
    expect(await walk(ORG, id.root, id.grandchild)).toBe(true);
  });

  it("allows a move into an unrelated root, which is the positive pair proving the guard is not simply rejecting every move", async () => {
    expect(await walk(ORG, id.root, id.unrelated)).toBe(false);
  });

  it("allows moving a descendant up under its own ancestor, because that direction creates no cycle and blocking it would make the tree unreorganisable", async () => {
    expect(await walk(ORG, id.grandchild, id.root)).toBe(false);
  });

  it("terminates on a parent chain already corrupted into a loop instead of recursing until the statement timeout, which is the failure a depth-capped CTE exists to prevent", async () => {
    await expect(walk(ORG, id.unrelated, id.loopB)).resolves.toBe(false);
  }, 30_000);

  it("finds the moved page inside a corrupted loop rather than missing it, so a tree already broken still cannot be broken further", async () => {
    expect(await walk(ORG, id.loopA, id.loopB)).toBe(true);
  }, 30_000);

  it("stops the walk at a soft-deleted ancestor, matching the deleted_at filter the previous in-memory guard applied to the rows it loaded", async () => {
    expect(await walk(ORG, id.root, id.belowDeleted)).toBe(false);
  });

  it("never leaves the caller's tenant: asking within one org about a page whose chain lives in another returns no hit, so a recursive step cannot walk into a foreign parent chain", async () => {
    expect(await walk(OTHER_ORG, id.root, id.foreign)).toBe(false);
  });
});
