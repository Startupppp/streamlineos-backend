import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { EventStreamService } from "./event-stream.service";
import {
  listEventsSchema,
  exportEventsSchema,
  type ListEventsInput,
  type ExportEventsInput,
} from "../dto/event-stream.schemas";

@RequireModule("hr")
@Controller("hr/enterprise/ops/event-stream")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EventStreamController {
  constructor(private readonly svc: EventStreamService) {}

  @Get("events")
  @RequirePermission("hr:eventstream:view")
  listEvents(
    @CurrentUser() user: CurrentUserContext,
    @Query(new ZodValidationPipe(listEventsSchema)) query: ListEventsInput,
  ) {
    return this.svc.listEvents(user.orgId, query);
  }

  @Get("data-dictionary")
  @RequirePermission("hr:eventstream:view")
  dataDictionary() {
    return this.svc.getDataDictionary();
  }

  @Get("metric-definitions")
  @RequirePermission("hr:eventstream:view")
  metricDefinitions() {
    return this.svc.getMetricDefinitions();
  }

  @Post("export")
  @RequirePermission("hr:analytics:read")
  export(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(exportEventsSchema)) body: ExportEventsInput,
  ) {
    return this.svc.exportEvents(user.orgId, body);
  }
}
