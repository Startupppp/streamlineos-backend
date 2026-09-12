import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { invAllocationOverrides, invLots } from "../../../../db/schema";
import { AccessService } from "../../../access/access.service";
import { InventorySettingsService } from "../../stock-engine/inventory-settings.service";
import {
  assertMayOverrideAllocation,
  daysRemaining,
  overridable,
  overriddenRule,
  refusalMessage,
  todayIso,
  verdictFor,
  type EligibilityPolicy,
  type LotFacts,
  type OverriddenRule,
} from "../../sales-orders/lot-eligibility";
import { clientBehindSource, resolveShelfLifeFloor } from "../../settings/min-shelf-life";
import type { CreateReservationInput } from "../dto/inv-stock.schemas";

/**
 * D2 — what an override record has to say, decided by asking what a reviewer
 * needs six months later to answer "who shipped the short-dated stock, and why".
 *
 * Everything here is a snapshot rather than a join. The lot may have been
 * consumed and purged, and the settings certainly may have been edited — a row
 * that has to join `inv_settings` to explain itself explains itself differently
 * every time somebody changes a setting, which is the opposite of a trail.
 */
export interface OverrideFacts {
  /** Which rule was set aside: the org's near-expiry block, or a customer floor. */
  readonly rule: OverriddenRule;
  readonly reason: string;
  readonly lotId: number;
  readonly lotNumber: string;
  readonly lotExpiryDate: string;
  readonly daysRemaining: number;
  readonly nearExpiryPolicy: string;
  readonly nearExpiryWindowDays: number;
  readonly minShelfLifeDays: number;
  /** Who receives it — null when the reservation names no customer document. */
  readonly clientId: number | null;
}

export type LotChoiceOutcome = { overridden: false } | { overridden: true; facts: OverrideFacts };

/**
 * Whether this caller may name a lot on a reservation, and whether doing so is
 * an override.
 *
 * Split out of `inv-stock-reservations.service.ts` (550 lines) unchanged. It
 * reads settings, the lot row and the caller's permissions and touches nothing
 * else on the service, so those three arrive as parameters rather than through
 * `this`. The rules move with it: an override reason naming no lot is a
 * contradiction, and naming a lot against the configured strategy needs both a
 * permission and a reason.
 */
export async function assertLotChoiceAllowed(
    db: Db,
    settingsService: InventorySettingsService,
    access: AccessService,
    orgId: string,
    userId: string,
    input: CreateReservationInput,
  ): Promise<LotChoiceOutcome> {
    if (input.lotId === undefined) {
      if (input.overrideReason !== undefined) {
        throw new BadRequestException(
          "An override reason was given for a reservation that names no lot — there is nothing to override.",
        );
      }
      return { overridden: false };
    }

    const settings = await settingsService.get(orgId);
    const lot = await db.query.invLots.findFirst({
      where: and(eq(invLots.orgId, orgId), eq(invLots.id, input.lotId)),
      columns: { id: true, lotNumber: true, expiryDate: true, status: true },
    });
    // A lot id from another tenant resolves to nothing here, and 404 is the
    // answer §4 requires — a 403 would confirm the row exists.
    if (!lot) throw new NotFoundException("Lot not found");

    // D2. The same floor `autoReserve` applied, resolved through the same helper
    // so a hand-raised reservation and an automatic one cannot hold two opinions
    // about what this customer agreed to accept.
    const clientId = await clientBehindSource(db, orgId, input.sourceType, input.sourceId);
    const floor = await resolveShelfLifeFloor(db, orgId, clientId);

    const lotById: ReadonlyMap<number, LotFacts> = new Map([[lot.id, lot]]);
    const policy: EligibilityPolicy = {
      expiryPolicy: settings.expiryReservationPolicy,
      nearExpiryPolicy: settings.nearExpiryPolicy,
      nearExpiryWindowDays: settings.nearExpiryWindowDays,
      minShelfLifeDays: floor.days,
    };
    const today = todayIso();
    const verdict = verdictFor(lot.id, lotById, policy, today);

    if (verdict.kind === "ELIGIBLE") {
      if (input.overrideReason !== undefined) {
        throw new BadRequestException(
          "That lot needs no override — the allocator would have chosen it.",
        );
      }
      return { overridden: false };
    }

    if (!overridable(verdict)) throw new BadRequestException(refusalMessage(verdict));

    if (!input.overrideReason) {
      throw new BadRequestException(
        `${refusalMessage(verdict)} Supply overrideReason to take it deliberately.`,
      );
    }

    await assertMayOverrideAllocation(access, orgId, userId);

    // Both are guaranteed by the branches above — `overridable` is only ever
    // true for a dated lot under one of the two judgement-call rules — but the
    // types do not know that, and a cast here would be a cast in the one place
    // the trail is written.
    const rule = overriddenRule(verdict);
    if (rule === null || lot.expiryDate === null) {
      throw new BadRequestException(refusalMessage(verdict));
    }

    return {
      overridden: true,
      facts: {
        rule,
        reason: input.overrideReason,
        lotId: lot.id,
        lotNumber: lot.lotNumber,
        lotExpiryDate: lot.expiryDate,
        daysRemaining: daysRemaining(lot.expiryDate, today),
        nearExpiryPolicy: settings.nearExpiryPolicy,
        nearExpiryWindowDays: settings.nearExpiryWindowDays,
        minShelfLifeDays: floor.days,
        clientId,
      },
    };
  }
