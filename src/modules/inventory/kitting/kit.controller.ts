import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  ParseIntPipe,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { KitService } from "./kit.service";
import {
  assembleKitSchema,
  buildableQuerySchema,
  disassembleKitSchema,
  setKitBomSchema,
} from "./dto/kitting.schemas";
import type {
  AssembleKitInput,
  BuildableQuery,
  DisassembleKitInput,
  SetKitBomInput,
} from "./dto/kitting.schemas";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  buildableKitsResponseSchema,
  kitAssemblyResponseSchema,
  kitBomResponseSchema,
} from "./dto/kitting-response.schemas";

/**
 * NEO-9 - kits.
 *
 * Editing a bill of materials is `inventory:products:update`: it is a fact about
 * the catalogue, and it is the key that already governs what a SKU is.
 *
 * Assembling is `inventory:kits:assemble`, its own key, because it posts stock
 * and changes valuation: it consumes components and creates a SKU that did not
 * exist a moment ago. Somebody who may edit a product description is not
 * automatically somebody who may do that.
 */
@RequireModule("inventory")
@Controller("inventory/kits")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class KitController {
  constructor(private readonly svc: KitService) {}

  @Get(":kitVariantId/bom")
  @ResponseSchema(kitBomResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:read")
  bom(
    @Param("kitVariantId", ParseIntPipe) kitVariantId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getBom(u.orgId, kitVariantId);
  }

  @Put(":kitVariantId/bom")
  @ResponseSchema(kitBomResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:update")
  setBom(
    @Param("kitVariantId", ParseIntPipe) kitVariantId: number,
    @Body(new ZodValidationPipe(setKitBomSchema)) body: SetKitBomInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.setBom(u.orgId, u.userId, kitVariantId, body);
  }

  @Get("buildable")
  @ResponseSchema(buildableKitsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  async buildable(
    @Query(new ZodValidationPipe(buildableQuerySchema)) query: BuildableQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return {
      kitVariantId: query.kitVariantId,
      warehouseId: query.warehouseId ?? null,
      buildable: await this.svc.buildable(u.orgId, u.userId, query.kitVariantId, query.warehouseId ?? null),
    };
  }

  @Post("assemble")
  @ResponseSchema(kitAssemblyResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:kits:assemble")
  assemble(
    @Body(new ZodValidationPipe(assembleKitSchema)) body: AssembleKitInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.assemble(u.orgId, u.userId, body, idempotencyKey);
  }

  @Post("disassemble")
  @ResponseSchema(kitAssemblyResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:kits:assemble")
  disassemble(
    @Body(new ZodValidationPipe(disassembleKitSchema)) body: DisassembleKitInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.disassemble(u.orgId, u.userId, body, idempotencyKey);
  }
}
