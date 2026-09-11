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
import { z } from "zod";
import { Validate } from "../../common/validation/validate.decorator";
import { OfferFulfillmentService } from "./offer-fulfillment.service";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  componentListSchema,
  componentDetailSchema,
  successSchema,
} from "./dto/offer-fulfillment-response.schemas";
import {
  createOfferFulfillmentSchema,
  listOfferFulfillmentQuerySchema,
  updateOfferFulfillmentSchema,
  type CreateOfferFulfillmentInput,
  type ListOfferFulfillmentQuery,
  type UpdateOfferFulfillmentInput,
} from "./dto/offer-fulfillment.schemas";

const offerFulfillmentComponentIdParams = z.object({ offerFulfillmentComponentId: z.coerce.number().int().positive() }).strict();

@RequireModule(["crm", "inventory"])
@Controller("offer-fulfillment")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class OfferFulfillmentController {
  constructor(private readonly svc: OfferFulfillmentService) {}

  @Get()
  @RequirePermission("crm:offer-fulfillment:view")
  @ResponseSchema(componentListSchema)
  @Validate({ query: listOfferFulfillmentQuerySchema })
  listComponents(
    @Query() query: ListOfferFulfillmentQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listComponents(u.orgId, query);
  }

  @Get(":offerFulfillmentComponentId")
  @RequirePermission("crm:offer-fulfillment:view")
  @ResponseSchema(componentDetailSchema)
  @Validate({ params: offerFulfillmentComponentIdParams })
  getComponent(
    @Param("offerFulfillmentComponentId", ParseIntPipe) offerFulfillmentComponentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getComponent(u.orgId, offerFulfillmentComponentId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("crm:offer-fulfillment:create")
  @ResponseSchema(componentDetailSchema)
  @Validate({ body: createOfferFulfillmentSchema })
  createComponent(
    @Body() body: CreateOfferFulfillmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createComponent(u.orgId, u.userId, body);
  }

  @Patch(":offerFulfillmentComponentId")
  @RequirePermission("crm:offer-fulfillment:update")
  @ResponseSchema(componentDetailSchema)
  @Validate({ params: offerFulfillmentComponentIdParams, body: updateOfferFulfillmentSchema })
  updateComponent(
    @Param("offerFulfillmentComponentId", ParseIntPipe) offerFulfillmentComponentId: number,
    @Body() body: UpdateOfferFulfillmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateComponent(u.orgId, u.userId, offerFulfillmentComponentId, body);
  }

  @Delete(":offerFulfillmentComponentId")
  @HttpCode(200)
  @RequirePermission("crm:offer-fulfillment:delete")
  @ResponseSchema(successSchema)
  @Validate({ params: offerFulfillmentComponentIdParams })
  deleteComponent(
    @Param("offerFulfillmentComponentId", ParseIntPipe) offerFulfillmentComponentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteComponent(u.orgId, u.userId, offerFulfillmentComponentId);
  }
}
