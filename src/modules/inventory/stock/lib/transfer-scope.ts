import { and, eq, sql, type SQL } from "drizzle-orm";
import { NotFoundException } from "@nestjs/common";
import { invStockTransfers } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import {
  WarehouseScopeService,
  type ResolvedWarehouseScope,
} from "../../stock-engine/warehouse-scope.service";

/**
 * Who may see a transfer, and which END of it each command answers for. Lifted
 * out of `inv-stock-transfers.service.ts` unchanged, with the reasoning that
 * makes the asymmetry deliberate rather than accidental.
 *
 * None of these had a caller outside that service. `loadTransfer` and
 * `assertCommandEnd` take the executor and the scope service as parameters; the
 * three predicate builders are pure.
 */
  /**
   * Which transfers this caller may see — the list's rule, now the only copy.
   *
   * BOTH ends, because a transfer is one document about two buildings: seeing a
   * single leg exposes the counterpart warehouse's movement, which is the rule
   * `listTransfers` has applied since the warehouse work landed and the one the
   * loads fix already borrowed for a transfer on a load line.
   *
   * The NULL half is worth stating because it differs by table on purpose.
   * `locationPredicate` renders `location_id IN (SELECT …)`, so a transfer whose
   * end is attributed to no location evaluates to NULL and is EXCLUDED for a
   * scoped caller — exactly what the list already did. That is not the handling
   * unit's rule, which keeps an `IS NULL` escape because a unit nested inside
   * another genuinely has no location of its own. Each detail follows its own
   * aggregate.
   *
   * Private and single so the detail and the four commands cannot drift from the
   * list: two hand-copied predicates agreeing today is not the same as them
   * being one predicate, and the list gaining a scope the rest were never told
   * about is the whole defect.
   */
export function transferInScope(
scope: ResolvedWarehouseScope): SQL {
    return sql`(${transferSourceInScope(scope)} AND ${transferDestinationInScope(scope)})`;
  }

  /**
   * The building the goods leave from, and the authority every command that
   * touches the SOURCE is measured against.
   *
   * The four commands below deliberately do NOT take `transferInScope` above,
   * and the reason is written into `createTransfer`: the source is asserted on
   * create and the destination is not, because an operator in one building
   * sending stock to another routinely holds no part of the destination.
   * Gating `reserve`, `dispatch` and `cancel` on both ends would therefore
   * refuse the very operator the create rule exists to allow — they could raise
   * an inter-warehouse transfer and then not reserve or dispatch it.
   *
   * So each command asks about the end it actually touches, and asks it through
   * this one definition rather than spelling out a fresh `scope.location(...)`
   * call per method. The list's pair is composed from the same two halves, so
   * nothing here can drift from the list either.
   */
export function transferSourceInScope(
scope: ResolvedWarehouseScope): SQL {
    return scope.location(sql`${invStockTransfers.fromLocationId}`);
  }

  /**
   * The building the goods arrive in. `completeTransfer` is a receipt, so this
   * is the end that answers for it — the same end the stock engine will assert
   * on the arrival movement a moment later.
   */
export function transferDestinationInScope(
scope: ResolvedWarehouseScope): SQL {
    return scope.location(sql`${invStockTransfers.toLocationId}`);
  }

  /**
   * One transfer, read whole, through whatever gate the caller earned.
   *
   * `gate` is `null` only for the two paths that have ALREADY settled the
   * caller's standing on the way in — `createTransfer` and `reserveTransfer`
   * both end by returning the document they just acted on, and both asserted
   * the source before they touched it. Handing them the list's both-ends
   * predicate would 404 an operator the transfer they have this instant
   * created, because the create rule lets them name a destination they do not
   * hold. Named so nobody routes to it by accident.
   */
export async function loadTransfer(
    db: Db,
orgId: string, transferId: number, gate: SQL | null) {
    return db.query.invStockTransfers.findFirst({
      where: gate === null
        ? and(eq(invStockTransfers.id, transferId), eq(invStockTransfers.orgId, orgId))
        : and(eq(invStockTransfers.id, transferId), eq(invStockTransfers.orgId, orgId), gate),
      with: {
        fromLocation: true,
        toLocation: true,
        fromWarehouse: { columns: { id: true, name: true } },
        toWarehouse: { columns: { id: true, name: true } },
        creator: { columns: { id: true, name: true } },
        lines: {
          with: {
            productVariant: { with: { product: { columns: { id: true, name: true, sku: true } } } },
            lot: { columns: { id: true, lotNumber: true } },
            serial: { columns: { id: true, serialNumber: true } },
          },
        },
      },
    });
  }

  /**
   * Reads the header, its lines, both bins, both buildings and who raised it.
   *
   * It took no `userId` at all — the controller had `@CurrentUser()` in hand and
   * passed only `orgId` — while the list beside it has narrowed on both ends
   * since the warehouse work landed. So a transfer an operator could not see in
   * their list was theirs to read whole by id, including the counterpart
   * warehouse's bin, quantities, lots and serials. Nothing downstream would have
   * caught it: a read posts no movements, so the engine's
   * `assertLocationsInScope` never runs on this path.
   *
   * Not cached, so there is no key to carry a scope discriminator — but if one
   * is ever added it must carry `scope.key`, or this becomes worse than the
   * unscoped read it replaces (§6).
   */
  /**
   * The object gate for a command, on the end that command actually touches.
   *
   * A projection rather than the whole document: this refuses BEFORE the status
   * is read, so a caller who may not see a transfer is told "not found" rather
   * than "only PENDING transfers can be reserved", which would report the
   * document's state to them. 404, never 403 (§4).
   */
export async function assertCommandEnd(
    db: Db,
    warehouseScope: WarehouseScopeService,

    orgId: string,
    userId: string,
    transferId: number,
    end: "source" | "destination",
  ): Promise<void> {
    const scope = await warehouseScope.forUser(orgId, userId);
    if (scope.unrestricted) return;
    const [visible] = await db
      .select({ id: invStockTransfers.id })
      .from(invStockTransfers)
      .where(
        and(
          eq(invStockTransfers.id, transferId),
          eq(invStockTransfers.orgId, orgId),
          end === "source"
            ? transferSourceInScope(scope)
            : transferDestinationInScope(scope),
        ),
      )
      .limit(1);
    if (!visible) throw new NotFoundException("Transfer not found");
  }
