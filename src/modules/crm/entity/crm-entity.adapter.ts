import { Inject, Injectable } from "@nestjs/common";
import { inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { deals } from "../../../db/schema";
import { businessParties, clientPartyMap } from "../../../db/schema/party";
import { PARTY_OF_CLIENT } from "../crm-party-reads";
import { AccessService } from "../../access/access.service";
import type { ScopedRead } from "../../access/scoped-read";
import { crmEntityReadScope } from "./crm-entity-scope";
import type { Permissions } from "../../entity-reference/entity-scope";
import {
  unresolved,
  type EntityAction,
  type EntityActionResult,
  type EntityActor,
  type EntityAdapter,
  type EntityCard,
  type EntityReference,
  type EntityResolution,
} from "../../entity-reference/entity-reference.types";

interface AccessPort {
  resolveUserPermissions(orgId: string, userId: string): Promise<Permissions>;
}

const READ_KEY: Record<string, string> = {
  client: "crm:clients:read",
  deal: "crm:deals:read",
};

@Injectable()
export class CrmEntityAdapter implements EntityAdapter {
  readonly moduleKey = "crm";
  readonly types = ["client", "deal"] as const;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(AccessService) private readonly access: AccessPort,
  ) {}

  async resolve(
    actor: EntityActor,
    references: EntityReference[],
  ): Promise<EntityResolution[]> {
    const permissions = await this.access.resolveUserPermissions(
      actor.orgId,
      actor.userId,
    );
    const results = references.map(unresolved);
    const wanted = new Map<
      string,
      { read: ScopedRead; entries: { id: number; index: number }[] }
    >();

    references.forEach((reference, index) => {
      const readKey = READ_KEY[reference.type];
      if (!readKey) return;
      const read = crmEntityReadScope(actor, permissions, readKey);
      if (read.denied) return;
      const id = Number(reference.id);
      if (!Number.isInteger(id) || id <= 0) return;
      const batch = wanted.get(reference.type) ?? { read, entries: [] };
      batch.entries.push({ id, index });
      wanted.set(reference.type, batch);
    });

    await Promise.all(
      [...wanted].map(async ([type, batch]) => {
        const ids = batch.entries.map((entry) => entry.id);
        const cards =
          type === "client"
            ? await this.readClients(batch.read, ids)
            : await this.readDeals(batch.read, ids);
        for (const entry of batch.entries) {
          const card = cards.get(entry.id);
          if (card) results[entry.index] = { status: "resolved", card };
        }
      }),
    );

    return results;
  }

  async actionsFor(
    _actor: EntityActor,
    references: EntityReference[],
  ): Promise<EntityAction[][]> {
    return references.map(() => []);
  }

  async submitAction(): Promise<EntityActionResult> {
    return { ok: false, reason: "invalid" };
  }

  private async readClients(read: ScopedRead, ids: number[]) {
    // No `deleted_at` predicate, because `clients` has none to inherit: a
    // soft-deleted party still answers here exactly as its client row did.
    return read.read(
      {
        tenant: clientPartyMap.organizationId,
        scope: { columns: { ownerColumn: businessParties.ownerUserId } },
        and: [inArray(clientPartyMap.clientId, ids)],
      },
      async ({ sql: where }) => {
        const rows = await this.db
          .select({
            id: clientPartyMap.clientId,
            name: businessParties.name,
            company: businessParties.companyName,
            status: businessParties.status,
          })
          .from(clientPartyMap)
          .innerJoin(businessParties, PARTY_OF_CLIENT)
          .where(where)
          .limit(ids.length);

        const byId = new Map<number, EntityCard>();
        for (const row of rows)
          byId.set(row.id, {
            type: "client",
            id: String(row.id),
            title: row.name,
            subtitle: row.company,
            status: row.status,
            href: `/crm/contacts/${row.id}`,
          });
        return byId;
      },
      () => new Map<number, EntityCard>(),
    );
  }

  private async readDeals(read: ScopedRead, ids: number[]) {
    return read.read(
      {
        tenant: deals.orgId,
        scope: { columns: { ownerColumn: deals.assignedToId } },
        and: [inArray(deals.id, ids), isNull(deals.deletedAt)],
      },
      async ({ sql: where }) => {
        const rows = await this.db
          .select({
            id: deals.id,
            name: deals.name,
            stage: deals.stage,
          })
          .from(deals)
          .where(where)
          .limit(ids.length);

        const byId = new Map<number, EntityCard>();
        for (const row of rows)
          byId.set(row.id, {
            type: "deal",
            id: String(row.id),
            title: row.name,
            subtitle: null,
            status: row.stage,
            href: `/crm/deals/${row.id}`,
          });
        return byId;
      },
      () => new Map<number, EntityCard>(),
    );
  }
}
