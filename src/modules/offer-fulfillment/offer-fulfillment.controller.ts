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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { OfferFulfillmentService } from "./offer-fulfillment.service";
import {
  createOfferFulfillmentSchema,
  listOfferFulfillmentQuerySchema,
  updateOfferFulfillmentSchema,
  type CreateOfferFulfillmentInput,
  type ListOfferFulfillmentQuery,
  type UpdateOfferFulfillmentInput,
} from "./dto/offer-fulfillment.schemas";

@RequireModule(["crm", "inventory"])
@Controller("offer-fulfillment")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class OfferFulfillmentController {
  constructor(private readonly svc: OfferFulfillmentService) {}

  @Get()
  @RequirePermission("crm:offer-fulfillment:view")
  listComponents(
    @Query(new ZodValidationPipe(listOfferFulfillmentQuerySchema))
    query: ListOfferFulfillmentQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listComponents(u.orgId, query);
  }

  @Get(":offerFulfillmentComponentId")
  @RequirePermission("crm:offer-fulfillment:view")
  getComponent(
    @Param("offerFulfillmentComponentId", ParseIntPipe) offerFulfillmentComponentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getComponent(u.orgId, offerFulfillmentComponentId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("crm:offer-fulfillment:create")
  createComponent(
    @Body(new ZodValidationPipe(createOfferFulfillmentSchema))
    body: CreateOfferFulfillmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createComponent(u.orgId, u.userId, body);
  }

  @Patch(":offerFulfillmentComponentId")
  @RequirePermission("crm:offer-fulfillment:update")
  updateComponent(
    @Param("offerFulfillmentComponentId", ParseIntPipe) offerFulfillmentComponentId: number,
    @Body(new ZodValidationPipe(updateOfferFulfillmentSchema))
    body: UpdateOfferFulfillmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateComponent(u.orgId, u.userId, offerFulfillmentComponentId, body);
  }

  @Delete(":offerFulfillmentComponentId")
  @HttpCode(200)
  @RequirePermission("crm:offer-fulfillment:delete")
  deleteComponent(
    @Param("offerFulfillmentComponentId", ParseIntPipe) offerFulfillmentComponentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteComponent(u.orgId, u.userId, offerFulfillmentComponentId);
  }
}
