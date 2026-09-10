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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ContractsService } from "./contracts.service";
import {
  createContractSchema,
  updateContractSchema,
  listContractsSchema,
  endContractSchema,
  convertToEmployeeSchema,
  daysQuerySchema,
  type CreateContractInput,
  type UpdateContractInput,
  type ListContractsInput,
  type EndContractInput,
  type ConvertToEmployeeInput,
} from "./dto/hr-global.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema, NoContentResponse } from "../../../common/openapi/zod-operation-contracts"
import { listContractsResponseSchema, listExpiringContractsResponseSchema, getContractResponseSchema, createContractResponseSchema, updateContractResponseSchema, endContractResponseSchema, convertToEmployeeResponseSchema, internshipCertificateResponseSchema, renewContractResponseSchema } from "./dto/global-response.schemas"

const contractIdParams = z.object({ contractId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/global/contracts")
@UseGuards(JwtAuthGuard)
export class ContractsController {
  constructor(private readonly service: ContractsService) {}

  @ResponseSchema(listContractsResponseSchema)
  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:contracts:view")
  @Validate({ query: listContractsSchema })
  list(
    @Query() query: ListContractsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, query);
  }

  @ResponseSchema(listExpiringContractsResponseSchema)
  @Get("renewal-due")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:contracts:manage")
  @Validate({ query: daysQuerySchema })
  renewalDue(
    @Query() { days }: z.infer<typeof daysQuerySchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, { limit: 100, days, status: "active" });
  }

  @ResponseSchema(getContractResponseSchema)
  @Get(":contractId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:contracts:view")
  @Validate({ params: contractIdParams })
  getOne(
    @Param("contractId", ParseIntPipe) contractId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getOne(u.orgId, contractId);
  }

  @ResponseSchema(createContractResponseSchema)
  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:contracts:manage")
  @HttpCode(201)
  @Validate({ body: createContractSchema })
  create(
    @Body() body: CreateContractInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  @ResponseSchema(updateContractResponseSchema)
  @Patch(":contractId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:contracts:manage")
  @Validate({ params: contractIdParams, body: updateContractSchema })
  update(
    @Param("contractId", ParseIntPipe) contractId: number,
    @Body() body: UpdateContractInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.update(u.orgId, contractId, u.userId, body);
  }

  @ResponseSchema(endContractResponseSchema)
  @Post(":contractId/end")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:contracts:manage")
  @HttpCode(200)
  @Validate({ params: contractIdParams, body: endContractSchema })
  endContract(
    @Param("contractId", ParseIntPipe) contractId: number,
    @Body() body: EndContractInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.endContract(u.orgId, contractId, u.userId, body);
  }

  @ResponseSchema(convertToEmployeeResponseSchema)
  @Post(":contractId/convert-to-employee")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:contracts:manage")
  @HttpCode(200)
  @Validate({ params: contractIdParams, body: convertToEmployeeSchema })
  convertToEmployee(
    @Param("contractId", ParseIntPipe) contractId: number,
    @Body() body: ConvertToEmployeeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.convertToEmployee(u.orgId, contractId, u.userId, body);
  }

  @ResponseSchema(internshipCertificateResponseSchema)
  @Get(":contractId/internship-certificate")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:contracts:view")
  @Validate({ params: contractIdParams })
  internshipCertificate(
    @Param("contractId", ParseIntPipe) contractId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.renderInternshipCertificate(u.orgId, contractId, u.userId);
  }

  @ResponseSchema(endContractResponseSchema)
  @Delete(":contractId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:contracts:manage")
  @Validate({ params: contractIdParams })
  remove(
    @Param("contractId", ParseIntPipe) contractId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.endContract(u.orgId, contractId, u.userId, {});
  }
}
