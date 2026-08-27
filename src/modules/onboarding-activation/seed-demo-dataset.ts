import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { activities, businessParties, deals, partyRoles } from "../../db/schema";
import type { TenantTx } from "../../common/tenant";
import {
  DEMO_PARTY_ROLE,
  DEMO_SOURCE,
  demoDataset,
  type DemoDataset,
} from "./demo-dataset";

function isoDate(from: Date, days: number): string {
  const at = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  return at.toISOString().slice(0, 10);
}

function daysBefore(from: Date, days: number): Date {
  return new Date(from.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Whether this organisation has already been given its demo dataset.
 *
 * Asked of the marker rather than of a flag somewhere else, so the answer cannot
 * disagree with what is actually in the tables. A single indexed lookup on the
 * tenant's own parties.
 */
async function alreadySeeded(tx: TenantTx, orgId: string): Promise<boolean> {
  const [existing] = await tx
    .select({ partyId: businessParties.partyId })
    .from(businessParties)
    .where(
      and(
        eq(businessParties.organizationId, orgId),
        eq(businessParties.acquisitionSource, DEMO_SOURCE),
      ),
    )
    .limit(1);

  return existing !== undefined;
}

/**
 * Put the demo dataset into a freshly provisioned workspace.
 *
 * Four statements, inside the caller's tenant transaction, so it commits with
 * the rest of provisioning or not at all — a workspace with half a demo in it
 * would be worse than one with none.
 *
 * Idempotent by the same marker the activation query filters on: a retried
 * claim finds the parties already there and does nothing, rather than seeding a
 * second copy and doubling the pipeline.
 *
 * Every row it writes is marked `streamline:demo`; see `demo-dataset.ts` for why
 * that matters and how `deals`, which has no provenance column, is recognised
 * through the party it is with.
 */
export async function seedDemoDataset(
  tx: TenantTx,
  orgId: string,
  ownerUserId: string,
  now: Date = new Date(),
  dataset: DemoDataset = demoDataset(),
): Promise<{ seeded: boolean }> {
  if (await alreadySeeded(tx, orgId)) return { seeded: false };

  const partyIdByKey = new Map(dataset.parties.map((party) => [party.key, randomUUID()]));

  await tx.insert(businessParties).values(
    dataset.parties.map((party) => ({
      partyId: partyIdByKey.get(party.key) ?? randomUUID(),
      organizationId: orgId,
      partyType: party.partyType,
      partyKind: party.partyKind,
      name: party.name,
      email: party.email,
      phone: party.phone,
      city: party.city,
      industry: party.industry,
      companyName: party.companyName ?? null,
      jobTitle: party.jobTitle ?? null,
      lifecycleStage: party.lifecycleStage,
      ownerUserId,
      tags: [...party.tags],
      acquisitionSource: DEMO_SOURCE,
    })),
  );

  await tx.insert(partyRoles).values(
    dataset.parties.map((party) => ({
      organizationId: orgId,
      partyId: partyIdByKey.get(party.key) ?? "",
      role: DEMO_PARTY_ROLE,
      assignedBy: DEMO_SOURCE,
    })),
  );

  const insertedDeals = await tx
    .insert(deals)
    .values(
      dataset.deals.map((deal) => ({
        orgId,
        name: deal.name,
        valueMinor: deal.valueMinor,
        stage: deal.stage,
        probability: deal.probability,
        partyId: partyIdByKey.get(deal.partyKey) ?? null,
        assignedToId: ownerUserId,
        expectedCloseDate: isoDate(now, deal.closesInDays),
        nextStep: deal.nextStep,
      })),
    )
    .returning({ id: deals.id, name: deals.name });

  // Matched on name rather than on position: a multi-row INSERT is under no
  // obligation to return its rows in the order they were given.
  const dealIdByName = new Map(insertedDeals.map((row) => [row.name, row.id]));
  const dealIdByKey = new Map(
    dataset.deals.map((deal) => [deal.key, dealIdByName.get(deal.name)]),
  );

  const activityRows = dataset.activities.flatMap((activity) => {
    const anchor =
      "party" in activity.anchor
        ? { partyId: partyIdByKey.get(activity.anchor.party) ?? null, dealId: null }
        : { partyId: null, dealId: dealIdByKey.get(activity.anchor.deal) };

    // Exactly one anchor, or the row is dropped rather than violating
    // `chk_activities_one_anchor` and taking provisioning down with it.
    if (anchor.partyId === null && (anchor.dealId === null || anchor.dealId === undefined))
      return [];

    const occurredAt = daysBefore(now, activity.daysAgo);

    return [
      {
        organizationId: orgId,
        kind: activity.kind,
        occurredAt,
        subject: activity.subject,
        body: activity.body,
        partyId: anchor.partyId,
        dealId: anchor.dealId === null || anchor.dealId === undefined ? null : String(anchor.dealId),
        actorKind: "human" as const,
        actorUserId: ownerUserId,
        source: DEMO_SOURCE,
        ...(activity.kind === "task"
          ? { assigneeUserId: ownerUserId, dueAt: daysBefore(now, -3) }
          : {}),
      },
    ];
  });

  if (activityRows.length > 0) await tx.insert(activities).values(activityRows);

  return { seeded: true };
}
