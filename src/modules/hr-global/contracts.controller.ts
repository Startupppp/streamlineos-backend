import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ContractsService } from "./contracts.service";
import {
  createContractSchema,
  updateContractSchema,
  listContractsSchema,
  endContractSchema,
  convertToEmployeeSchema,
  type CreateContractInput,
  type UpdateContractInput,
  type ListContractsInput,
  type EndContractInput,
  type ConvertToEmployeeInput,
} from "./dto/hr-global.schemas";

const daysQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(3650).default(30) });

@RequireModule("hr")
@Controller("hr/global/contracts")
@UseGuards(JwtAuthGuard)
export class ContractsController {
  constructor(private readonly service: ContractsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:contracts:view")
  list(
    @Query(new ZodValidationPipe(listContractsSchema)) query: ListContractsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, query);
  }

  @Get("renewal-due")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:contracts:manage")
  renewalDue(
    @Query(new ZodValidationPipe(daysQuerySchema)) { days }: z.infer<typeof daysQuerySchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, { page: 1, limit: 100, days, status: "active" });
  }

  @Get(":contractId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:contracts:view")
  getOne(
    @Param("contractId", ParseIntPipe) contractId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getOne(u.orgId, contractId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:contracts:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createContractSchema)) body: CreateContractInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  @Patch(":contractId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:contracts:manage")
  update(
    @Param("contractId", ParseIntPipe) contractId: number,
    @Body(new ZodValidationPipe(updateContractSchema)) body: UpdateContractInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.update(u.orgId, contractId, u.userId, body);
  }

  @Post(":contractId/end")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:contracts:manage")
  @HttpCode(200)
  endContract(
    @Param("contractId", ParseIntPipe) contractId: number,
    @Body(new ZodValidationPipe(endContractSchema)) body: EndContractInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.endContract(u.orgId, contractId, u.userId, body);
  }

  @Post(":contractId/convert-to-employee")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:contracts:manage")
  @HttpCode(200)
  convertToEmployee(
    @Param("contractId", ParseIntPipe) contractId: number,
    @Body(new ZodValidationPipe(convertToEmployeeSchema)) body: ConvertToEmployeeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.convertToEmployee(u.orgId, contractId, u.userId, body);
  }

  @Get(":contractId/internship-certificate")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:contracts:view")
  internshipCertificate(
    @Param("contractId", ParseIntPipe) contractId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.renderInternshipCertificate(u.orgId, contractId, u.userId);
  }

  @Delete(":contractId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:contracts:manage")
  remove(
    @Param("contractId", ParseIntPipe) contractId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.endContract(u.orgId, contractId, u.userId, {});
  }
}
