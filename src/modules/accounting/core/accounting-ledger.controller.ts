import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AccessService } from "../../access/access.service";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccountingLedgerService } from "./accounting-ledger.service";
import { resolveAccountingJournalViewScope } from "./accounting-scope";
import {
  createAccountSchema,
  createJournalEntrySchema,
  listAccountsQuerySchema,
  listJournalQuerySchema,
  updateAccountSchema,
  type CreateAccountInput,
  type CreateJournalEntryInput,
  type ListAccountsQuery,
  type ListJournalQuery,
  type UpdateAccountInput,
} from "./dto/accounting.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { actingMembershipId } from "../../../common/auth/principal";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const accountIdParams = z.object({ accountId: z.coerce.number().int().positive() }).strict();
const entryIdParams = z.object({ entryId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting")
@UseGuards(JwtAuthGuard)
export class AccountingLedgerController {
  constructor(
    private readonly ledger: AccountingLedgerService,
    private readonly access: AccessService,
  ) {}

  @Get("accounts")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:accounts:read")
  @Validate({ query: listAccountsQuerySchema })
  listAccounts(
    @Query() query: ListAccountsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ledger.listAccounts(u.orgId, query);
  }

  @Post("accounts")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:accounts:create")
  @HttpCode(201)
  @Validate({ body: createAccountSchema })
  createAccount(
    @Body() body: CreateAccountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ledger.createAccount(u.orgId, body);
  }

  @Patch("accounts/:accountId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:accounts:update")
  @Validate({ params: accountIdParams, body: updateAccountSchema })
  updateAccount(
    @Param("accountId", ParseIntPipe) accountId: number,
    @Body() body: UpdateAccountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ledger.updateAccount(u.orgId, accountId, body);
  }

  @Get("journal")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:read")
  @Validate({ query: listJournalQuerySchema })
  async listJournal(
    @Query() query: ListJournalQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveAccountingJournalViewScope(this.access, u);
    return this.ledger.listJournal(u.orgId, query, scope, u.userId, actingMembershipId(u.principal) ?? 0);
  }

  @Post("journal")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:manage")
  @HttpCode(201)
  @Validate({ body: createJournalEntrySchema })
  createJournalEntry(
    @Body() body: CreateJournalEntryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ledger.createJournalEntry(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0, body);
  }

  @Get("journal/:entryId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:read")
  @Validate({ params: entryIdParams })
  getJournalEntry(
    @Param("entryId", ParseIntPipe) entryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ledger.getJournalEntry(u.orgId, entryId);
  }

  @Post("journal/:entryId/post")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:manage")
  @HttpCode(200)
  @Validate({ params: entryIdParams })
  postJournalEntry(
    @Param("entryId", ParseIntPipe) entryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ledger.postJournalEntry(u.orgId, u.userId, entryId);
  }

  @Post("journal/:entryId/reverse")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:manage")
  @Validate({ params: entryIdParams })
  async reverseJournalEntry(
    @Param("entryId", ParseIntPipe) entryId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { created, result } = await this.ledger.reverseJournalEntry(u.orgId, u.userId, entryId);
    res.status(created ? 201 : 200);
    return result;
  }
}
