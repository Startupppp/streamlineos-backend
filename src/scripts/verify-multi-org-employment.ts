import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { and, eq, isNull } from "drizzle-orm";
import { EmploymentVerificationContextModule } from "./employment-verification-context";
import { EmploymentFactsService } from "../modules/directory/employment-facts.service";
import { DRIZZLE } from "../db/drizzle.constants";
import type { Db } from "../db/drizzle.module";
import { hrEmployments, hrPeople, organizationMembers, organizations } from "../db/schema";
import { runInNewTenantTransaction } from "../common/tenant/run-in-tenant-transaction";

type Placement = { orgId: string; employmentId: number; original: string | null };

async function findMultiOrgUser(db: Db): Promise<{ userId: string; orgIds: string[] } | null> {
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  const byUser = new Map<string, string[]>();

  for (const org of orgs) {
    let memberIds: string[];
    try {
      memberIds = await runInNewTenantTransaction(db, org.id, async (tx) => {
        const rows = await tx
          .selectDistinct({ userId: organizationMembers.userId })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.orgId, org.id),
              eq(organizationMembers.status, "ACTIVE"),
            ),
          );
        return rows.map((row) => row.userId);
      });
    } catch {
      continue;
    }
    for (const userId of memberIds) byUser.set(userId, [...(byUser.get(userId) ?? []), org.id]);
  }

  for (const [userId, orgIds] of byUser)
    if (orgIds.length >= 2) return { userId, orgIds: orgIds.slice(0, 2) };
  return null;
}

async function employmentFor(
  db: Db,
  orgId: string,
  userId: string,
): Promise<{ employmentId: number; designation: string | null } | null> {
  return runInNewTenantTransaction(db, orgId, async (tx) => {
    const [row] = await tx
      .select({ employmentId: hrEmployments.id, designation: hrEmployments.designation })
      .from(hrEmployments)
      .innerJoin(
        hrPeople,
        and(eq(hrPeople.id, hrEmployments.personId), eq(hrPeople.orgId, hrEmployments.orgId)),
      )
      .where(
        and(
          eq(hrEmployments.orgId, orgId),
          eq(hrEmployments.isPrimary, true),
          isNull(hrEmployments.deletedAt),
          eq(hrPeople.userId, userId),
          isNull(hrPeople.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

function setDesignation(
  db: Db,
  orgId: string,
  employmentId: number,
  designation: string | null,
): Promise<void> {
  return runInNewTenantTransaction(db, orgId, async (tx) => {
    await tx
      .update(hrEmployments)
      .set({ designation })
      .where(and(eq(hrEmployments.id, employmentId), eq(hrEmployments.orgId, orgId)));
  });
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(EmploymentVerificationContextModule, {
    logger: ["error"],
  });
  const db = app.get<Db>(DRIZZLE);
  const facts = app.get(EmploymentFactsService);
  const placements: Placement[] = [];

  try {
    const subject = await findMultiOrgUser(db);
    if (!subject) {
      console.log(
        JSON.stringify({ skipped: true, reason: "no user holds two active memberships" }),
      );
      process.exitCode = 1;
      return;
    }

    const [orgA, orgB] = subject.orgIds;
    if (!orgA || !orgB) throw new Error("expected two organisations");

    const employmentA = await employmentFor(db, orgA, subject.userId);
    const employmentB = await employmentFor(db, orgB, subject.userId);
    if (!employmentA || !employmentB)
      throw new Error("the subject does not have an employment in both organisations");

    placements.push({ orgId: orgA, employmentId: employmentA.employmentId, original: employmentA.designation });
    placements.push({ orgId: orgB, employmentId: employmentB.employmentId, original: employmentB.designation });

    await setDesignation(db, orgA, employmentA.employmentId, "Contractor in org A");
    await setDesignation(db, orgB, employmentB.employmentId, "Head of Engineering in org B");

    const factsA = await runInNewTenantTransaction(db, orgA, () =>
      facts.getFacts(orgA, subject.userId),
    );
    const factsB = await runInNewTenantTransaction(db, orgB, () =>
      facts.getFacts(orgB, subject.userId),
    );

    const independent =
      factsA.designation === "Contractor in org A" &&
      factsB.designation === "Head of Engineering in org B" &&
      factsA.employmentId !== factsB.employmentId;

    console.log(
      JSON.stringify(
        {
          userId: subject.userId,
          orgA: { orgId: orgA, employmentId: factsA.employmentId, designation: factsA.designation },
          orgB: { orgId: orgB, employmentId: factsB.employmentId, designation: factsB.designation },
          independent,
          legacyFallbackPossible: false,
        },
        null,
        2,
      ),
    );
    process.exitCode = independent ? 0 : 1;
  } finally {
    for (const placement of placements)
      await setDesignation(db, placement.orgId, placement.employmentId, placement.original).catch(
        (err: unknown) => console.error("restore failed", err),
      );
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
