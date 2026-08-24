import { inArray } from "drizzle-orm";
import { type Db } from "src/db/drizzle.module";
import { organizations, users } from "src/db/schema";

export async function seedOrg(db: Db, id: string, slug: string): Promise<void> {
  await db.insert(organizations)
    .values({ id, name: id, slug, ownerMembershipId: 0 })
    .onConflictDoNothing();
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
