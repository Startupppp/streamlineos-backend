import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import {
  clientPartyMap,
  contactPartyMap,
  crmOrgPartyMap,
  leadPartyMap,
} from "../../db/schema";

export interface LegacyIdsByKind {
  lead: number[];
  client: number[];
  contact: number[];
  organisation?: number[];
}

export async function legacyIdsOf(
  db: Db,
  organizationId: string,
  partyId: string,
): Promise<LegacyIdsByKind> {
  const [lead, client, contact, organisation] = await Promise.all([
    db
      .select({ id: leadPartyMap.leadId })
      .from(leadPartyMap)
      .where(
        and(
          eq(leadPartyMap.organizationId, organizationId),
          eq(leadPartyMap.partyId, partyId),
        ),
      ),
    db
      .select({ id: clientPartyMap.clientId })
      .from(clientPartyMap)
      .where(
        and(
          eq(clientPartyMap.organizationId, organizationId),
          eq(clientPartyMap.partyId, partyId),
        ),
      ),
    db
      .select({ id: contactPartyMap.contactId })
      .from(contactPartyMap)
      .where(
        and(
          eq(contactPartyMap.organizationId, organizationId),
          eq(contactPartyMap.partyId, partyId),
        ),
      ),
    db
      .select({ id: crmOrgPartyMap.crmOrganizationId })
      .from(crmOrgPartyMap)
      .where(
        and(
          eq(crmOrgPartyMap.organizationId, organizationId),
          eq(crmOrgPartyMap.partyId, partyId),
        ),
      ),
  ]);

  return {
    lead: lead.map((row) => row.id),
    client: client.map((row) => row.id),
    contact: contact.map((row) => row.id),
    organisation: organisation.map((row) => row.id),
  };
}

export async function repointLegacyIds(
  db: Db,
  organizationId: string,
  ids: LegacyIdsByKind,
  partyId: string,
): Promise<void> {
  if (ids.lead.length > 0)
    await db
      .update(leadPartyMap)
      .set({ partyId })
      .where(
        and(
          eq(leadPartyMap.organizationId, organizationId),
          inArray(leadPartyMap.leadId, ids.lead),
        ),
      );

  if (ids.client.length > 0)
    await db
      .update(clientPartyMap)
      .set({ partyId })
      .where(
        and(
          eq(clientPartyMap.organizationId, organizationId),
          inArray(clientPartyMap.clientId, ids.client),
        ),
      );

  if (ids.contact.length > 0)
    await db
      .update(contactPartyMap)
      .set({ partyId })
      .where(
        and(
          eq(contactPartyMap.organizationId, organizationId),
          inArray(contactPartyMap.contactId, ids.contact),
        ),
      );

  if (ids.organisation && ids.organisation.length > 0)
    await db
      .update(crmOrgPartyMap)
      .set({ partyId })
      .where(
        and(
          eq(crmOrgPartyMap.organizationId, organizationId),
          inArray(crmOrgPartyMap.crmOrganizationId, ids.organisation),
        ),
      );
}
