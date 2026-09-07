import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { EventStreamService } from "./event-stream.service";
import {
  listEventsSchema,
  exportEventsSchema,
  type ListEventsInput,
  type ExportEventsInput,
} from "../dto/event-stream.schemas";
import { Validate } from "../../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../../common/openapi/zod-operation-contracts"
import { listHrEventsResponseSchema, getDataDictionaryResponseSchema, getEventStreamMetricDefinitionsResponseSchema, exportHrEventsResponseSchema } from "../dto/enterprise-ops-response.schemas"

@RequireModule("hr")
@Controller("hr/enterprise/ops/event-stream")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EventStreamController {
  constructor(private readonly svc: EventStreamService) {}

  @ResponseSchema(listHrEventsResponseSchema)
  @Get("events")
  @RequirePermission("hr:eventstream:view")
  @Validate({ query: listEventsSchema })
  listEvents(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ListEventsInput,
  ) {
    return this.svc.listEvents(user.orgId, query);
  }

  @ResponseSchema(getDataDictionaryResponseSchema)
  @Get("data-dictionary")
  @RequirePermission("hr:eventstream:view")
  dataDictionary() {
    return this.svc.getDataDictionary();
  }

  @ResponseSchema(getEventStreamMetricDefinitionsResponseSchema)
  @Get("metric-definitions")
  @RequirePermission("hr:eventstream:view")
  metricDefinitions() {
    return this.svc.getMetricDefinitions();
  }

  @ResponseSchema(exportHrEventsResponseSchema)
  @Post("export")
  @RequirePermission("hr:analytics:read")
  @Validate({ body: exportEventsSchema })
  export(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: ExportEventsInput,
  ) {
    return this.svc.exportEvents(user.orgId, body);
  }
}
