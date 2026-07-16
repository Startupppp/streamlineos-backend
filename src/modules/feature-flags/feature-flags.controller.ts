import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PlatformOwnerGuard } from "../../common/auth/platform-owner.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { FeatureFlagsService } from "./feature-flags.service";
import {
  createFlagSchema,
  updateFlagSchema,
  orgOverrideSchema,
  type CreateFlagInput,
  type UpdateFlagInput,
  type OrgOverrideInput,
} from "./dto/feature-flag.schemas";

const listQuerySchema = z.object({
  includeArchived: z
    .string()
    .optional()
    .transform((v) => v === "true"),
}).strict();

type ListQuery = z.infer<typeof listQuerySchema>;

@Controller("feature-flags")
@UseGuards(JwtAuthGuard, PlatformOwnerGuard)
export class FeatureFlagsController {
  constructor(private readonly service: FeatureFlagsService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listQuerySchema)) query: ListQuery) {
    return this.service.list(query);
  }

  @Get(":key")
  get(@Param("key") key: string) {
    return this.service.get(key);
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createFlagSchema)) body: CreateFlagInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(body, u.userId);
  }

  @Patch(":key")
  @HttpCode(200)
  update(
    @Param("key") key: string,
    @Body(new ZodValidationPipe(updateFlagSchema)) body: UpdateFlagInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.update(key, body, u.userId).then(() => ({ message: "Flag updated" }));
  }

  @Delete(":key")
  @HttpCode(200)
  archive(@Param("key") key: string, @CurrentUser() u: CurrentUserContext) {
    return this.service.archive(key, u.userId).then(() => ({ message: "Flag archived" }));
  }

  @Post(":key/override")
  @HttpCode(200)
  setOrgOverride(
    @Param("key") key: string,
    @Body(new ZodValidationPipe(orgOverrideSchema)) body: OrgOverrideInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service
      .setOrgOverride(key, body.orgId, body.enabled, u.userId)
      .then(() => ({ message: "Override set" }));
  }

  @Delete(":key/override/:orgId")
  @HttpCode(200)
  removeOrgOverride(
    @Param("key") key: string,
    @Param("orgId") orgId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service
      .removeOrgOverride(key, orgId, u.userId)
      .then(() => ({ message: "Override removed" }));
  }
}
