import { Inject, Injectable } from "@nestjs/common";
import { eq, and, asc, type SQL } from "drizzle-orm";
import { clientOpportunities } from "../../db/schema";
import { businessParties, clientPartyMap } from "../../db/schema/party";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  CLIENT_PARTY_COLUMNS,
  CLIENT_PARTY_JOIN,
  clientIdIs,
  clientPartyScope,
} from "./client-party-reader";
import type { CreateOpportunityInput, UpdateOpportunityInput } from "./dto/clients.schemas";

@Injectable()
export class ClientOpportunitiesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string, clientId: number | undefined) {
    const conditions: SQL[] = [eq(clientOpportunities.orgId, orgId)];
    if (clientId) conditions.push(eq(clientOpportunities.clientId, clientId));

    return this.db
      .select({
        id: clientOpportunities.id,
        orgId: clientOpportunities.orgId,
        clientId: clientOpportunities.clientId,
        title: clientOpportunities.title,
        type: clientOpportunities.type,
        stage: clientOpportunities.stage,
        value: clientOpportunities.value,
        notes: clientOpportunities.notes,
        expectedCloseDate: clientOpportunities.expectedCloseDate,
        createdBy: clientOpportunities.createdBy,
        createdAt: clientOpportunities.createdAt,
        updatedAt: clientOpportunities.updatedAt,
        client: { id: CLIENT_PARTY_COLUMNS.id, name: CLIENT_PARTY_COLUMNS.name },
      })
      .from(clientOpportunities)
      // The old join carried no tenant predicate at all -- `client_id = id` and
      // nothing else -- so it leaned entirely on the foreign key having been
      // written for the right organisation. The map row is matched on the tenant
      // as well, and the join onto the party carries it across.
      .leftJoin(
        clientPartyMap,
        and(
          eq(clientPartyMap.clientId, clientOpportunities.clientId),
          eq(clientPartyMap.organizationId, orgId),
        ),
      )
      .leftJoin(businessParties, CLIENT_PARTY_JOIN)
      .where(and(...conditions))
      // `created_at` is not unique, so a hundredth row was previously whichever
      // the heap offered; the id settles it.
      .orderBy(asc(clientOpportunities.createdAt), asc(clientOpportunities.id))
      .limit(100);
  }

  async create(orgId: string, userId: string, input: CreateOpportunityInput) {
    const [client] = await this.db
      .select({ id: CLIENT_PARTY_COLUMNS.id })
      .from(clientPartyMap)
      .innerJoin(businessParties, CLIENT_PARTY_JOIN)
      .where(and(...clientPartyScope(orgId), clientIdIs(input.clientId)))
      .limit(1);
    if (!client) return null;

    const [inserted] = await this.db
      .insert(clientOpportunities)
      .values({
        orgId,
        clientId: input.clientId,
        title: input.title,
        type: input.type,
        stage: input.stage,
        value: input.value ?? null,
        notes: input.notes ?? null,
        expectedCloseDate: input.expectedCloseDate ?? null,
        createdBy: userId,
      })
      .returning();

    return inserted;
  }

  async update(orgId: string, oppId: number, input: UpdateOpportunityInput) {
    const existing = await this.db.query.clientOpportunities.findFirst({
      where: and(eq(clientOpportunities.id, oppId), eq(clientOpportunities.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) return null;

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (input.title !== undefined) updateData.title = input.title;
    if (input.type !== undefined) updateData.type = input.type;
    if (input.stage !== undefined) updateData.stage = input.stage;
    if (input.value !== undefined) updateData.value = input.value;
    if (input.notes !== undefined) updateData.notes = input.notes;
    if (input.expectedCloseDate !== undefined) updateData.expectedCloseDate = input.expectedCloseDate;

    const [updated] = await this.db
      .update(clientOpportunities)
      .set(updateData)
      .where(and(eq(clientOpportunities.id, oppId), eq(clientOpportunities.orgId, orgId)))
      .returning();

    return updated;
  }

  async remove(orgId: string, oppId: number) {
    const existing = await this.db.query.clientOpportunities.findFirst({
      where: and(eq(clientOpportunities.id, oppId), eq(clientOpportunities.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) return null;

    await this.db
      .delete(clientOpportunities)
      .where(and(eq(clientOpportunities.id, oppId), eq(clientOpportunities.orgId, orgId)));

    return { success: true };
  }
}
