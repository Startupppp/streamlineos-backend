import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { CreditNotesService } from "./credit-notes.service";
import {
  createCreditNoteSchema,
  listCreditNotesSchema,
  applyCreditNoteSchema,
  type CreateCreditNoteInput,
  type ListCreditNotesQuery,
  type ApplyCreditNoteInput,
} from "./dto/finance-ar.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  creditNoteListResponseSchema,
  creditNoteCreatedResponseSchema,
  creditNoteDetailResponseSchema,
  creditNotePostResponseSchema,
  creditNoteApplyResponseSchema,
} from "./dto/ar-response.schemas";

const creditNoteIdParams = z.object({ creditNoteId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/credit-notes")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CreditNotesController {
  constructor(private readonly svc: CreditNotesService) {}

  @Get()
  @ResponseSchema(creditNoteListResponseSchema)
  @RequirePermission("accounting:credit-notes:read")
  @Validate({ query: listCreditNotesSchema })
  list(
    @Query() query: ListCreditNotesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, query);
  }

  @Post()
  @ResponseSchema(creditNoteCreatedResponseSchema)
  @HttpCode(201)
  @RequirePermission("accounting:credit-notes:create")
  @Idempotent("accounting.credit-note.create")
  @Validate({ body: createCreditNoteSchema })
  create(
    @Body() body: CreateCreditNoteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Get(":creditNoteId")
  @ResponseSchema(creditNoteDetailResponseSchema)
  @RequirePermission("accounting:credit-notes:read")
  @Validate({ params: creditNoteIdParams })
  get(
    @Param("creditNoteId", ParseIntPipe) creditNoteId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.get(u.orgId, creditNoteId);
  }

  @Post(":creditNoteId/post")
  @ResponseSchema(creditNotePostResponseSchema)
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("accounting:credit-notes:manage")
  @Idempotent("accounting.credit-note.post")
  @Validate({ params: creditNoteIdParams })
  postNote(
    @Param("creditNoteId", ParseIntPipe) creditNoteId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.post(u.orgId, u.userId, creditNoteId);
  }

  @Post(":creditNoteId/apply")
  @ResponseSchema(creditNoteApplyResponseSchema)
  @HttpCode(200)
  @RequirePermission("accounting:credit-notes:manage")
  @Idempotent("accounting.credit-note.apply")
  @Validate({ params: creditNoteIdParams, body: applyCreditNoteSchema })
  apply(
    @Param("creditNoteId", ParseIntPipe) creditNoteId: number,
    @Body() body: ApplyCreditNoteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.apply(u.orgId, u.userId, creditNoteId, body);
  }
}
