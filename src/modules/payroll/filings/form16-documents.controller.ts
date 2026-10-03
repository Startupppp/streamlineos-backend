import { Controller, Get, HttpCode, Param, Post, Query, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiOkResponse } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { Validate } from "../../../common/validation/validate.decorator";
import { MultipartAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { FORM16_MAX_UPLOAD_BYTES, Form16DocumentsService } from "./form16-documents.service";
import {
  form16FyParamsSchema,
  form16ListQuerySchema,
  form16ListResponseSchema,
  form16MemberParamsSchema,
  form16ReleaseAllResponseSchema,
  form16RowSchema,
  type Form16ListQuery,
} from "./dto/form16-documents.schemas";

@RequireModule("payroll")
@Controller("payroll/form16")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayrollForm16DocumentsController {
  constructor(private readonly form16: Form16DocumentsService) {}

  @Get()
  @RequirePermission("payroll:tax:view")
  @Validate({ query: form16ListQuerySchema })
  @ResponseSchema(form16ListResponseSchema)
  list(@CurrentUser() u: CurrentUserContext, @Query() query: Form16ListQuery) {
    return this.form16.list(u.orgId, query.financialYear);
  }

  @Post(":financialYear/release-all")
  @HttpCode(200)
  @RequirePermission("payroll:tax:manage")
  @Validate({ params: form16FyParamsSchema })
  @ResponseSchema(form16ReleaseAllResponseSchema)
  releaseAll(@CurrentUser() u: CurrentUserContext, @Param("financialYear") financialYear: string) {
    return this.form16.releaseAll(actorOf(u), financialYear);
  }

  @Post(":financialYear/members/:membershipId/upload")
  @HttpCode(201)
  @RequirePermission("payroll:tax:manage")
  @Validate({ params: form16MemberParamsSchema })
  @ResponseSchema(form16RowSchema)
  @MultipartAction({ file: "file", fileRequired: true })
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: FORM16_MAX_UPLOAD_BYTES } }))
  upload(
    @CurrentUser() u: CurrentUserContext,
    @Param("financialYear") financialYear: string,
    @Param("membershipId") membershipId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.form16.upload(actorOf(u), financialYear, Number(membershipId), file);
  }

  @Post(":financialYear/members/:membershipId/release")
  @HttpCode(200)
  @RequirePermission("payroll:tax:manage")
  @Validate({ params: form16MemberParamsSchema })
  @ResponseSchema(form16RowSchema)
  release(
    @CurrentUser() u: CurrentUserContext,
    @Param("financialYear") financialYear: string,
    @Param("membershipId") membershipId: string,
  ) {
    return this.form16.release(actorOf(u), financialYear, Number(membershipId));
  }

  @Get(":financialYear/members/:membershipId/download")
  @RequirePermission("payroll:tax:view")
  @Validate({ params: form16MemberParamsSchema })
  @ApiOkResponse({ description: "Form 16 PDF", content: { "application/pdf": { schema: { type: "string", format: "binary" } } } })
  download(
    @CurrentUser() u: CurrentUserContext,
    @Param("financialYear") financialYear: string,
    @Param("membershipId") membershipId: string,
  ): Promise<StreamableFile> {
    return this.form16.download(u.orgId, financialYear, Number(membershipId));
  }
}

function actorOf(u: CurrentUserContext) {
  return { orgId: u.orgId, userId: u.userId, membershipId: actingMembershipId(u.principal) };
}
