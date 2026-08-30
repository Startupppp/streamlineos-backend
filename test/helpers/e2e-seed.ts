import { eq, inArray, sql } from "drizzle-orm";
import { type Db } from "src/db/drizzle.module";
import { organizations, organizationMembers, users } from "src/db/schema";

/**
 * Inserts a minimal organisation with a synthetic owner membership, wiring the
 * circular FK (organizations.owner_membership_id → organization_members.id) by
 * pre-allocating the sequence value and committing org + member atomically.
 * The FK is DEFERRABLE INITIALLY DEFERRED, so the temporary violation resolves
 * at COMMIT rather than at each statement.
 *
 * Skips the whole transaction when the org already exists so repeated calls in
 * a shared test session are safe.
 */
export async function seedOrg(db: Db, id: string, slug: string): Promise<void> {
  const existing = await db.query.organizations.findFirst({
    where: eq(organizations.id, id),
    columns: { id: true },
  });
  if (existing) return;

  await db.transaction(async (tx) => {
    const seqRows = await tx.execute(
      sql`SELECT nextval(pg_get_serial_sequence('organization_members', 'id')) AS id`,
    );
    const ownerMembershipId = Number(seqRows[0]?.["id"]);
    if (!Number.isInteger(ownerMembershipId) || ownerMembershipId <= 0)
      throw new Error(`seedOrg: could not allocate owner membership id for ${id}`);

    const ownerId = `${id}-seed-owner`;
    await tx.insert(users)
      .values({ id: ownerId, email: `owner-${id}@test.invalid` })
      .onConflictDoNothing();

    await tx.insert(organizations)
      .values({ id, name: id, slug, ownerMembershipId })
      .onConflictDoNothing();

    await tx.insert(organizationMembers)
      .values({
        id: ownerMembershipId,
        userId: ownerId,
        orgId: id,
        role: "OWNER",
        isOwner: true,
        status: "ACTIVE",
      })
      .onConflictDoNothing();
  });
}

export async function seedUser(db: Db, id: string, email: string): Promise<void> {
  await db.insert(users).values({ id, email }).onConflictDoNothing();
}

export async function cleanupSeedOrgs(db: Db, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(organizations).where(inArray(organizations.id, ids));
}

export async function cleanupSeedUsers(db: Db, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(users).where(inArray(users.id, ids));
}
