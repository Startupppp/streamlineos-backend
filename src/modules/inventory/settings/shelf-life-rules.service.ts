import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import { businessParties, clientPartyMap, invCustomerShelfLifeRules } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { isLegacyResolved, resolveLegacyParty } from "../../party/party-legacy-seam";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import type { PutShelfLifeRuleInput } from "./dto/settings.schemas";

/**
 * D2 — reading and writing the minimum-shelf-life contract.
 *
 * Deliberately one endpoint for both rungs. The house floor and a customer's own
 * floor are the same kind of statement about the same thing, and giving them two
 * routes would invite two shapes, two validators and eventually two answers to
 * "what floor applies here".
 *
 * `minShelfLifeDays: 0` deletes the rule rather than storing a zero. A stored
 * zero is a rule that does nothing while reading, on a settings screen, as a
 * rule somebody set — and "no floor" already has a representation, which is the
 * absence of a row. The database refuses a zero too (`chk_inv_cslr_days`), so
 * the two cannot drift.
 */
@Injectable()
export class ShelfLifeRulesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: InventoryAuditService,
  ) {}

  /**
   * Every rule this organisation holds, house row first.
   *
   * Not paginated: the house row plus one row per customer that negotiated a
   * floor is a settings screen, and a tenant with enough of them to page has a
   * different problem. The customer's name is joined because a settings screen
   * showing `client_id: 4182` is a bug (frontend §5).
   */
  async list(orgId: string) {
    const rows = await this.db
      .select({
        id: invCustomerShelfLifeRules.id,
        clientId: invCustomerShelfLifeRules.clientId,
        clientName: businessParties.name,
        minShelfLifeDays: invCustomerShelfLifeRules.minShelfLifeDays,
        notes: invCustomerShelfLifeRules.notes,
        updatedAt: invCustomerShelfLifeRules.updatedAt,
      })
      .from(invCustomerShelfLifeRules)
      // The name comes from the Party, through the map — never from `clients`,
      // which is being retired. A per-row `resolveLegacyParty` would be the
      // seam's own entry point and also an N+1 the seam's list helper exists to
      // avoid; that helper returns party ids only, so the join is spelled out
      // here over the same two tables it walks.
      .leftJoin(
        clientPartyMap,
        and(
          eq(clientPartyMap.organizationId, orgId),
          eq(clientPartyMap.clientId, invCustomerShelfLifeRules.clientId),
        ),
      )
      .leftJoin(
        businessParties,
        and(
          eq(businessParties.organizationId, orgId),
          eq(businessParties.partyId, clientPartyMap.partyId),
        ),
      )
      .where(eq(invCustomerShelfLifeRules.orgId, orgId))
      // NULLS FIRST: the house floor is the one that applies when nothing else
      // does, so it reads first.
      .orderBy(asc(invCustomerShelfLifeRules.clientId));

    return {
      items: rows.map((row) => ({ ...row, scope: row.clientId === null ? "HOUSE" : "CUSTOMER" })),
    };
  }

  async put(orgId: string, userId: string, input: PutShelfLifeRuleInput) {
    const clientId = input.clientId ?? null;

    if (clientId !== null) {
      // §4: a customer id from another tenant must resolve to 404, not to a
      // foreign-key violation that confirms the row exists somewhere. The seam
      // re-asserts `orgId` on its own query and answers `unresolved` as a value
      // rather than a throw, which is exactly the shape that maps to 404.
      const resolution = await resolveLegacyParty(this.db, orgId, {
        kind: "CLIENT",
        legacyId: clientId,
      });
      if (!isLegacyResolved(resolution)) throw new NotFoundException("Customer not found");
    }

    const where = and(
      eq(invCustomerShelfLifeRules.orgId, orgId),
      clientId === null
        ? isNull(invCustomerShelfLifeRules.clientId)
        : eq(invCustomerShelfLifeRules.clientId, clientId),
    );

    const existing = await this.db
      .select({
        id: invCustomerShelfLifeRules.id,
        minShelfLifeDays: invCustomerShelfLifeRules.minShelfLifeDays,
      })
      .from(invCustomerShelfLifeRules)
      .where(where)
      .limit(1);
    const before = existing[0] ?? null;

    if (input.minShelfLifeDays === 0) {
      if (!before) {
        throw new BadRequestException(
          "There is no shelf-life rule here to clear — a floor of zero is the absence of a rule, not a rule.",
        );
      }
      await this.db.transaction(async (tx) => {
        await tx.delete(invCustomerShelfLifeRules).where(where);
        await this.audit.insert(tx, {
          orgId,
          actorUserId: userId,
          action: "settings.shelf_life_rule.cleared",
          resourceType: "inv_customer_shelf_life_rule",
          resourceId: String(before.id),
          before: { clientId, minShelfLifeDays: before.minShelfLifeDays },
        });
      });
      return { clientId, minShelfLifeDays: 0, cleared: true };
    }

    const saved = await this.db.transaction(async (tx) => {
      if (before) {
        await tx
          .update(invCustomerShelfLifeRules)
          .set({
            minShelfLifeDays: input.minShelfLifeDays,
            notes: input.notes ?? null,
            updatedAt: new Date(),
          })
          .where(where);
      } else {
        await tx.insert(invCustomerShelfLifeRules).values({
          orgId,
          clientId,
          minShelfLifeDays: input.minShelfLifeDays,
          notes: input.notes ?? null,
          createdBy: userId,
        });
      }

      const [row] = await tx
        .select({
          id: invCustomerShelfLifeRules.id,
          clientId: invCustomerShelfLifeRules.clientId,
          minShelfLifeDays: invCustomerShelfLifeRules.minShelfLifeDays,
          notes: invCustomerShelfLifeRules.notes,
        })
        .from(invCustomerShelfLifeRules)
        .where(where)
        .limit(1);
      if (!row) throw new NotFoundException("Shelf-life rule not found");

      // A change to a floor changes which lots every future allocation for that
      // customer may take, so it is a policy edit and belongs in the trail
      // beside the overrides it will cause.
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: before ? "settings.shelf_life_rule.updated" : "settings.shelf_life_rule.created",
        resourceType: "inv_customer_shelf_life_rule",
        resourceId: String(row.id),
        before: before ? { minShelfLifeDays: before.minShelfLifeDays } : null,
        after: { clientId, minShelfLifeDays: row.minShelfLifeDays, notes: row.notes },
      });

      return row;
    });

    return { ...saved, scope: clientId === null ? "HOUSE" : "CUSTOMER", cleared: false };
  }
}
