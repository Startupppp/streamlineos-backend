import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { BooksService } from "../kernel/books.service";
import { ArAgingService } from "./ar-aging.service";
import { agingQuerySchema, type AgingQuery } from "./dto/ar-aging.schemas";

@RequireModule("accounting")
@Controller("accounting/ar/aging")
@UseGuards(JwtAuthGuard)
export class ArAgingController {
  constructor(
    private readonly aging: ArAgingService,
    private readonly books: BooksService,
  ) {}

  /** Buckets by party, plus the AR-control reconciliation the PRD asks for. */
  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:receivables:read")
  report(
    @Query(new ZodValidationPipe(agingQuerySchema)) query: AgingQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.aging.aging(u.orgId, query);
  }

  /** The same data one document per row, for a statement or a CSV export. */
  @Get("open-items")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:receivables:read")
  async openItems(
    @Query(new ZodValidationPipe(agingQuerySchema)) query: AgingQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const book = await this.books.requireDefault(u.orgId);
    const asOf = query.asOf ?? new Date().toISOString().slice(0, 10);
    return this.aging.openItems(
      u.orgId,
      book.id,
      book.baseCurrency,
      asOf,
      query.basis ?? "due",
      { partyId: query.partyId, currency: query.currency },
    );
  }
}
