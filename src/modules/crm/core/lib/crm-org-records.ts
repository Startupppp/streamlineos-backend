import { aliasedTable, and, asc, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import { deals } from "../../../../db/schema";
import { businessParties, contactPartyMap, leadPartyMap } from "../../../../db/schema/party";
import { PARTY_OF_LEAD, leadPriority, leadSource, leadStatus } from "../../crm-party-reads";
import { companies, type CrmOrgHierarchyDeps } from "./crm-org-hierarchy";

/**
 * A company's RECORDS: who works there, what was sold, which leads it came from.
 *
 * The rollup next door counts the same joins; these two return the rows. That is
 * the difference worth seeing — a count of five deals is cheap and cacheable at
 * any size, and a list of them is not, which is why both of these carry a `limit`
 * and the rollup does not.
 *
 * They also share the one thing in this service that is not an id join. A
 * company's deals and leads are reached by ILIKE on its NAME, because neither
 * `deals` nor a lead party carries a company id — a heuristic, and a fragile one,
 * so both escape `%` in the name before interpolating it. (`getRelatedLeads`
 * escapes `_` as well and the timeline does not; that difference is older than
 * this split and is left alone here rather than quietly changed.)
 *
 * `employee` is the other half of the self-referential employer link, and these
 * two functions are its only users — which is why it moved with them rather than
 * staying as a module-level alias in a file that no longer mentions it.
 */

/** The person end of the self-referential employer link; see the company end. */
const employee = aliasedTable(businessParties, "employee_party");

export interface OrgTimelineEvent {
  id: string;
  date: string;
  type: "contact_created" | "deal_created" | "lead_linked" | "note_added";
  description: string;
  entityId: number;
}

export async function queryAccountTimeline(
  deps: CrmOrgHierarchyDeps,
  orgId: string,
  accountId: number,
  limit: number,
): Promise<OrgTimelineEvent[]> {
  const [company] = await companies(deps, orgId, [accountId]);
  if (!company) return [];

  const safeName = company.name.replaceAll("%", "\\%");

  const [employees, dealRows, leadRows] = await Promise.all([
    // Everyone whose employer is this company, through `employer_party_id`
    // rather than `contacts.organization_id`. The contact id still comes back
    // off the map, because the event carries one and every link the client
    // draws is still a `contacts` URL.
    deps.db
      .select({
        id: contactPartyMap.contactId,
        name: employee.name,
        createdAt: employee.createdAt,
      })
      .from(employee)
      .innerJoin(
        contactPartyMap,
        and(
          eq(contactPartyMap.partyId, employee.partyId),
          eq(contactPartyMap.organizationId, employee.organizationId),
        ),
      )
      .where(
        and(
          eq(employee.organizationId, orgId),
          eq(employee.employerPartyId, company.partyId),
        ),
      )
      .orderBy(desc(employee.createdAt), desc(contactPartyMap.contactId))
      .limit(limit),
    deps.db
      .select({ id: deals.id, name: deals.name, stage: deals.stage, createdAt: deals.createdAt })
      .from(deals)
      .where(
        and(
          eq(deals.orgId, orgId),
          isNull(deals.deletedAt),
          ilike(deals.name, `%${safeName}%`),
        ),
      )
      .orderBy(desc(deals.createdAt), desc(deals.id))
      .limit(limit),
    deps.db
      .select({
        id: leadPartyMap.leadId,
        name: businessParties.name,
        createdAt: businessParties.createdAt,
      })
      .from(leadPartyMap)
      .innerJoin(businessParties, PARTY_OF_LEAD)
      .where(
        and(
          eq(leadPartyMap.organizationId, orgId),
          isNull(businessParties.deletedAt),
          ilike(businessParties.companyName, `%${safeName}%`),
        ),
      )
      .orderBy(desc(businessParties.createdAt), desc(leadPartyMap.leadId))
      .limit(limit),
  ]);

  const events: OrgTimelineEvent[] = [];

  for (const person of employees)
    events.push({
      id: `contact-${person.id}`,
      date: person.createdAt.toISOString(),
      type: "contact_created",
      description: `Contact "${person.name}" added to organization`,
      entityId: person.id,
    });

  for (const d of dealRows)
    events.push({
      id: `deal-${d.id}`,
      date: d.createdAt?.toISOString() ?? new Date().toISOString(),
      type: "deal_created",
      description: `Deal "${d.name}" (${d.stage}) linked`,
      entityId: d.id,
    });

  for (const l of leadRows)
    events.push({
      id: `lead-${l.id}`,
      date: l.createdAt?.toISOString() ?? new Date().toISOString(),
      type: "lead_linked",
      description: `Lead "${l.name ?? "Unnamed"}" linked (company match)`,
      entityId: l.id,
    });

  if (company.notes)
    events.push({
      id: `note-${accountId}`,
      date: new Date().toISOString(),
      type: "note_added",
      description: "Account notes updated",
      entityId: accountId,
    });

  return events
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, limit);
}

export async function getRelatedLeads(
  deps: CrmOrgHierarchyDeps,
  orgId: string,
  id: number,
) {
  const [company] = await companies(deps, orgId, [id]);
  if (!company) return null;

  const safeName = company.name.replaceAll("%", "\\%").replaceAll("_", "\\_");

  /*
   * The leads whose free-text employer looks like this company, plus the ones an
   * employee of it came from. That second half is `converted_from_party_id`
   * since 0265, so it compares party to party -- the map is still joined to
   * confirm the employee is a contact, and to keep the set the same one the
   * legacy `contacts.lead_id` read produced.
   */
  const employeeLeadPartyIds = await deps.db
    .select({ leadPartyId: employee.convertedFromPartyId })
    .from(employee)
    .innerJoin(
      contactPartyMap,
      and(
        eq(contactPartyMap.partyId, employee.partyId),
        eq(contactPartyMap.organizationId, employee.organizationId),
      ),
    )
    .where(
      and(
        eq(employee.organizationId, orgId),
        eq(employee.employerPartyId, company.partyId),
      ),
    )
    .then((rows) =>
      rows.map((row) => row.leadPartyId).filter((id): id is string => id !== null),
    );

  const conditions = [ilike(businessParties.companyName, `%${safeName}%`)];
  if (employeeLeadPartyIds.length > 0)
    conditions.push(inArray(businessParties.partyId, employeeLeadPartyIds));

  return deps.db
    .select({
      id: leadPartyMap.leadId,
      name: businessParties.name,
      email: businessParties.email,
      phone: businessParties.phone,
      status: leadStatus,
      priority: leadPriority,
      company: businessParties.companyName,
      source: leadSource,
      createdAt: businessParties.createdAt,
    })
    .from(leadPartyMap)
    .innerJoin(businessParties, PARTY_OF_LEAD)
    .where(
      and(
        eq(leadPartyMap.organizationId, orgId),
        isNull(businessParties.deletedAt),
        or(...conditions),
      ),
    )
    .orderBy(asc(businessParties.createdAt), asc(leadPartyMap.leadId))
    .limit(50);
}
