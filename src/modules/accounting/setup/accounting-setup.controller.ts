import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { enableAccountingSchema, type EnableAccountingInputDto } from "../kernel/dto/kernel.schemas";
import { AccountingSetupService } from "./accounting-setup.service";
import { OpeningBalancesService } from "./opening-balances.service";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { postedJournalResponseSchema } from "../kernel/dto/kernel-response.schemas";
import {
  addTaxRegistrationResponseSchema,
  listTaxRegistrationsResponseSchema,
  openingBalancesPreviewResponseSchema,
  setupEnableResponseSchema,
  setupStatusResponseSchema,
} from "./dto/accounting-setup-response.schemas";

const taxRegistrationSchema = z
  .object({
    regime: z.enum([
      "GST_IN", "VAT_EU", "VAT_GB", "VAT_GCC", "GST_SG", "GST_AU",
      "GST_HST_CA", "SALES_TAX_US", "PAN_IN", "TAN_IN", "EIN_US", "GENERIC",
    ]),
    number: z.string().min(2).max(64),
    region: z.string().max(16).nullish(),
    countryCode: z.string().regex(/^[A-Za-z]{2}$/),
    isPrimary: z.boolean().optional(),
  })
  .strict();
type TaxRegistrationInputDto = z.infer<typeof taxRegistrationSchema>;

const openingBalancesSchema = z
  .object({
    asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date as YYYY-MM-DD"),
    memo: z.string().max(500).optional(),
    lines: z
      .array(
        z
          .object({
            accountId: z.string().min(1),
            // Signed: positive debits the account, negative credits it.
            amountMinor: z.number().int("Amounts are whole minor units, not a decimal"),
          })
          .strict(),
      )
      .min(1, "Enter at least one opening balance"),
  })
  .strict();
type OpeningBalancesInputDto = z.infer<typeof openingBalancesSchema>;

/**
 * Onboarding. One call turns accounting on: book, chart of accounts, fiscal
 * year, periods and the pack's tax codes.
 */
@RequireModule("accounting")
@Controller("accounting/setup")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class AccountingSetupController {
  constructor(
    private readonly setup: AccountingSetupService,
    private readonly openingBalances: OpeningBalancesService,
  ) {}

  @Get("status")
  @ResponseSchema(setupStatusResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:settings:read")
  status(@CurrentUser() u: CurrentUserContext) {
    return this.setup.status(u.orgId);
  }

  @Post("enable")
  @ResponseSchema(setupEnableResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:settings:manage")
  enable(
    @Body(new ZodValidationPipe(enableAccountingSchema)) body: EnableAccountingInputDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.setup.enable(u.orgId, u.userId, body);
  }

  @Get("tax-registrations")
  @ResponseSchema(listTaxRegistrationsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:settings:read")
  listTaxRegistrations(@CurrentUser() u: CurrentUserContext) {
    return this.setup.listTaxRegistrations(u.orgId);
  }

  @Post("tax-registrations")
  @ResponseSchema(addTaxRegistrationResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:settings:manage")
  addTaxRegistration(
    @Body(new ZodValidationPipe(taxRegistrationSchema)) body: TaxRegistrationInputDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.setup.addTaxRegistration(u.orgId, u.userId, body);
  }

  /** Shows what the equity plug will absorb before anything is written. */
  @Post("opening-balances/preview")
  @ResponseSchema(openingBalancesPreviewResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:settings:read")
  previewOpeningBalances(
    @Body(new ZodValidationPipe(openingBalancesSchema)) body: OpeningBalancesInputDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.openingBalances.preview(u.orgId, body);
  }

  @Post("opening-balances")
  @ResponseSchema(postedJournalResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:post")
  postOpeningBalances(
    @Body(new ZodValidationPipe(openingBalancesSchema)) body: OpeningBalancesInputDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.openingBalances.post(u.orgId, u.userId, body);
  }
}
