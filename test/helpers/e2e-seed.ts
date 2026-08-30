import { eq, inArray, sql } from "drizzle-orm";
import { type Db } from "src/db/drizzle.module";
import { organizationMembers, organizations, users } from "src/db/schema";

/**
 * An organisation, and the owner membership it is required to point at.
 *
 * `organizations.owner_membership_id` is NOT NULL and carries a composite
 * foreign key to `organization_members (org_id, id)` — so an org needs a
 * membership that needs the org. The constraint is `DEFERRABLE INITIALLY
 * DEFERRED` for exactly that reason: inside one transaction the pointer may be
 * wrong until COMMIT, when it is checked once.
 *
 * This used to insert the org alone with `owner_membership_id = 0`, which
 * predates `0311` adding the constraint. Outside a transaction the deferred
 * check fires at statement end, so every suite using this helper failed to seed
 * and then failed every test in the file — including its 401 and cross-tenant
 * cases, which is how a broken fixture reads as a broken guard.
 */
export async function seedOrg(db: Db, id: string, slug: string): Promise<void> {
  await db.transaction(async (tx) => {
    const ownerUserId = `${id}__seed_owner`;

    /**
     * The tenant context, set before anything under a policy is written.
     *
     * `organization_members` carries `tenant_isolation`, so an insert with no
     * `app.organization_id` is refused with 42501 "no tenant context". That was
     * invisible for as long as the tests connected as an owner, which bypasses
     * RLS — the moment `APP_DATABASE_URL` points at the non-owner role the
     * application actually uses, every suite calling this helper fails to seed
     * and then fails every case in the file, including its 401 ones. A broken
     * fixture reading as a broken guard is the same failure this helper's other
     * docblock is about.
     *
     * `organizations` itself carries no tenant column and therefore no policy,
     * which is what makes seeding the row that defines the tenant possible at
     * all. Local to the transaction, so it cannot leak into the next one.
     */
    await tx.execute(sql`select set_config('app.organization_id', ${id}, true)`);

    await tx
      .insert(users)
      .values({ id: ownerUserId, email: `${slug}@seed.invalid` })
      .onConflictDoNothing();

    await tx
      .insert(organizations)
      .values({ id, name: id, slug, ownerMembershipId: 0 })
      .onConflictDoNothing();

    const [membership] = await tx
      .insert(organizationMembers)
      .values({ userId: ownerUserId, orgId: id, role: "OWNER", isOwner: true })
      .onConflictDoNothing()
      .returning({ id: organizationMembers.id });

    // Absent only when the org was already seeded, in which case its pointer is
    // already a real membership — a wrong one would not have committed.
    if (membership)
      await tx
        .update(organizations)
        .set({ ownerMembershipId: membership.id })
        .where(eq(organizations.id, id));
  });
}

export async function seedUser(db: Db, id: string, email: string): Promise<void> {
  await db.insert(users).values({ id, email }).onConflictDoNothing();
}

/** The org goes first, so the owner-membership guard sees a null pointer and allows the cascade. */
export async function cleanupSeedOrgs(db: Db, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(organizations).where(inArray(organizations.id, ids));
  await db.delete(users).where(inArray(users.id, ids.map((id) => `${id}__seed_owner`)));
}

export async function cleanupSeedUsers(db: Db, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(users).where(inArray(users.id, ids));
}
