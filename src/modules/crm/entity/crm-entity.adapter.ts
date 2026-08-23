import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { clients, deals } from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
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

type Permissions = Map<string, DataScope>;

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
    const wanted = new Map<string, { id: number; index: number }[]>();

    references.forEach((reference, index) => {
      const readKey = READ_KEY[reference.type];
      if (!readKey) return;
      if (!this.holds(actor, permissions, readKey)) return;
      const id = Number(reference.id);
      if (!Number.isInteger(id) || id <= 0) return;
      const batch = wanted.get(reference.type) ?? [];
      batch.push({ id, index });
      wanted.set(reference.type, batch);
    });

    await Promise.all(
      [...wanted].map(async ([type, batch]) => {
        const cards =
          type === "client"
            ? await this.readClients(
                actor.orgId,
                batch.map((entry) => entry.id),
              )
            : await this.readDeals(
                actor.orgId,
                batch.map((entry) => entry.id),
              );
        for (const entry of batch) {
          const card = cards.get(entry.id);
          if (card) results[entry.index] = { status: "resolved", card };
        }
      }),
    );

    return results;
  }

  /** CRM records are referenceable but carry no in-chat actions yet. */
  async actionsFor(
    _actor: EntityActor,
    references: EntityReference[],
  ): Promise<EntityAction[][]> {
    return references.map(() => []);
  }

  async submitAction(): Promise<EntityActionResult> {
    return { ok: false, reason: "invalid" };
  }

  private holds(
    actor: EntityActor,
    permissions: Permissions,
    key: string,
  ): boolean {
    if (actor.isOrgOwner) return true;
    const scope = permissions.get(key);
    return scope !== undefined && scope !== "none";
  }

  private async readClients(orgId: string, ids: number[]) {
    const rows = await this.db
      .select({
        id: clients.id,
        name: clients.name,
        company: clients.company,
        status: clients.status,
      })
      .from(clients)
      .where(and(eq(clients.orgId, orgId), inArray(clients.id, ids)))
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
  }

  private async readDeals(orgId: string, ids: number[]) {
    const rows = await this.db
      .select({
        id: deals.id,
        name: deals.name,
        stage: deals.stage,
      })
      .from(deals)
      .where(
        and(eq(deals.orgId, orgId), inArray(deals.id, ids), isNull(deals.deletedAt)),
      )
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
  }
}
