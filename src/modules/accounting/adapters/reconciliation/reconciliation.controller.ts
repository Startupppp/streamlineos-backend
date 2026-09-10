import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { ZodValidationPipe } from "../../../../common/pipes/zod-validation.pipe";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { UnpostedMovementsService } from "./unposted-movements.service";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const unpostedMovementsQuerySchema = z
  .object({
    from: z.string().regex(ISO_DATE, "from must be YYYY-MM-DD"),
    to: z.string().regex(ISO_DATE, "to must be YYYY-MM-DD"),
  })
  .strict()
  .refine((q) => q.from <= q.to, { message: "from must not be after to", path: ["from"] });

export type UnpostedMovementsQueryDto = z.infer<typeof unpostedMovementsQuerySchema>;

/**
 * Reconciliation across the inventory boundary.
 *
 * It lives in `adapters/` rather than in `reports/` deliberately. Every service
 * under `reports/` is a reader of the ledger and nothing else — that is what
 * makes a report trustworthy, because there is no stored number to drift. This
 * one has to read `inv_stock_transactions` as well, which is a boundary
 * crossing, and the adapters directory is where boundary crossings are allowed
 * to be visible. Putting it under `reports/` would quietly make the reporting
 * layer depend on inventory's column names.
 *
 * Read-only, like everything it sits beside.
 */
@RequireModule("accounting")
@Controller("accounting/reconciliation")
@UseGuards(JwtAuthGuard)
export class ReconciliationController {
  constructor(private readonly unposted: UnpostedMovementsService) {}

  /**
   * Stock that moved and never reached the ledger.
   *
   * Gated on `accounting:reports:read` rather than an inventory key: the
   * question it answers is "does my balance sheet describe my stock", which is
   * a finance question about finance's own numbers.
   */
  @Get("unposted-movements")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  getUnpostedMovements(
    @Query(new ZodValidationPipe(unpostedMovementsQuerySchema))
    query: UnpostedMovementsQueryDto,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.unposted.report(user.orgId, query.from, query.to);
  }
}
