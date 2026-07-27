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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
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

@Controller("timesheets/exceptions")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ExceptionsController {
  constructor(
    private readonly exceptions: ExceptionsService,
    private readonly detector: ExceptionsDetectorService,
  ) {}

  @Get()
  @RequirePermission("timesheets:exceptions:view")
  list(
    @Query(new ZodValidationPipe(exceptionsQuerySchema)) query: ExceptionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exceptions.listExceptions(u, query);
  }

  @Get("summary")
  @RequirePermission("timesheets:exceptions:view")
  summary(@CurrentUser() u: CurrentUserContext) {
    return this.exceptions.summary(u);
  }

  @Post(":exceptionId/resolve")
  @HttpCode(200)
  @RequirePermission("timesheets:exceptions:manage")
  resolve(
    @Param("exceptionId", ParseIntPipe) exceptionId: number,
    @Body(new ZodValidationPipe(resolveExceptionSchema)) body: ResolveExceptionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exceptions.resolveException(u, exceptionId, body);
  }

  @Post(":exceptionId/dismiss")
  @HttpCode(200)
  @RequirePermission("timesheets:exceptions:manage")
  dismiss(
    @Param("exceptionId", ParseIntPipe) exceptionId: number,
    @Body(new ZodValidationPipe(dismissExceptionSchema)) body: DismissExceptionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exceptions.dismissException(u, exceptionId, body);
  }

  @Post("run-detection")
  @HttpCode(200)
  @RequirePermission("timesheets:exceptions:manage")
  runDetection(@CurrentUser() u: CurrentUserContext) {
    return this.detector.detectForOrg(u.orgId);
  }
}
