import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ExceptionsService } from "./exceptions.service";
import { ExceptionsDetectorService } from "./exceptions-detector.service";
import {
  exceptionsQuerySchema,
  resolveExceptionSchema,
  dismissExceptionSchema,
  type ExceptionsQuery,
  type ResolveExceptionInput,
  type DismissExceptionInput,
} from "./dto/exceptions.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { z } from "zod";
import {
  exceptionsListResponseSchema,
  exceptionsSummaryResponseSchema,
  exceptionResolutionResponseSchema,
  detectorResponseSchema,
} from "./dto/timesheets-response.schemas";

const exceptionIdParams = z.object({ exceptionId: z.coerce.number().int().positive() }).strict();

@RequireModule("timesheets")
@Controller("timesheets/exceptions")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class TimesheetExceptionsController {
  constructor(
    private readonly exceptions: ExceptionsService,
    private readonly detector: ExceptionsDetectorService,
  ) {}

  @Get()
  @RequirePermission("timesheets:exceptions:view")
  @Validate({ query: exceptionsQuerySchema })
  @ResponseSchema(exceptionsListResponseSchema)
  list(
    @Query() query: ExceptionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exceptions.listExceptions(u, query);
  }

  @Get("summary")
  @RequirePermission("timesheets:exceptions:view")
  @ResponseSchema(exceptionsSummaryResponseSchema)
  summary(@CurrentUser() u: CurrentUserContext) {
    return this.exceptions.summary(u);
  }

  @Post(":exceptionId/resolve")
  @HttpCode(200)
  @RequirePermission("timesheets:exceptions:manage")
  @Validate({ params: exceptionIdParams, body: resolveExceptionSchema })
  @ResponseSchema(exceptionResolutionResponseSchema)
  resolve(
    @Param("exceptionId", ParseIntPipe) exceptionId: number,
    @Body() body: ResolveExceptionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exceptions.resolveException(u, exceptionId, body);
  }

  @Post(":exceptionId/dismiss")
  @HttpCode(200)
  @RequirePermission("timesheets:exceptions:manage")
  @Validate({ params: exceptionIdParams, body: dismissExceptionSchema })
  @ResponseSchema(exceptionResolutionResponseSchema)
  dismiss(
    @Param("exceptionId", ParseIntPipe) exceptionId: number,
    @Body() body: DismissExceptionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exceptions.dismissException(u, exceptionId, body);
  }

  @Post("run-detection")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("timesheets:exceptions:manage")
  @ResponseSchema(detectorResponseSchema)
  runDetection(@CurrentUser() u: CurrentUserContext) {
    return this.detector.detectForOrg(u.orgId);
  }
}
