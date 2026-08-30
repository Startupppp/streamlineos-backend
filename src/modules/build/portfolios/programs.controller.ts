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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ProgramsService } from "./programs.service";
import {
  createProgramSchema,
  linkProjectSchema,
  listProgramsQuerySchema,
  updateProgramSchema,
  type CreateProgramInput,
  type LinkProjectInput,
  type ListProgramsQuery,
  type UpdateProgramInput,
} from "./dto/portfolios.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const programIdParams = z.object({ programId: z.coerce.number().int().positive() }).strict();
const programIdprojectIdParams = z.object({ programId: z.coerce.number().int().positive(), projectId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProgramsController {
  constructor(private readonly svc: ProgramsService) {}

  @Get("programs")
  @RequirePermission("build:programs:view")
  listPrograms(
    @Query(new ZodValidationPipe(listProgramsQuerySchema)) query: ListProgramsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listPrograms(u.orgId, query);
  }

  @Get("programs/:programId")
  @RequirePermission("build:programs:view")
  @Validate({ params: programIdParams })
  getProgram(
    @Param("programId", ParseIntPipe) programId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getProgram(u.orgId, programId);
  }

  @Post("programs")
  @HttpCode(201)
  @RequirePermission("build:programs:manage")
  createProgram(
    @Body(new ZodValidationPipe(createProgramSchema)) body: CreateProgramInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createProgram(u.orgId, u.userId, body);
  }

  @Patch("programs/:programId")
  @RequirePermission("build:programs:manage")
  @Validate({ params: programIdParams })
  updateProgram(
    @Param("programId", ParseIntPipe) programId: number,
    @Body(new ZodValidationPipe(updateProgramSchema)) body: UpdateProgramInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateProgram(u.orgId, u.userId, programId, body);
  }

  @Delete("programs/:programId")
  @HttpCode(204)
  @RequirePermission("build:programs:manage")
  @Validate({ params: programIdParams })
  deleteProgram(
    @Param("programId", ParseIntPipe) programId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteProgram(u.orgId, u.userId, programId);
  }

  @Post("programs/:programId/projects")
  @HttpCode(200)
  @RequirePermission("build:programs:manage")
  @Validate({ params: programIdParams })
  linkProject(
    @Param("programId", ParseIntPipe) programId: number,
    @Body(new ZodValidationPipe(linkProjectSchema)) body: LinkProjectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.linkProject(u.orgId, u.userId, programId, body);
  }

  @Delete("programs/:programId/projects/:projectId")
  @HttpCode(204)
  @RequirePermission("build:programs:manage")
  @Validate({ params: programIdprojectIdParams })
  unlinkProject(
    @Param("programId", ParseIntPipe) programId: number,
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.unlinkProject(u.orgId, u.userId, programId, projectId);
  }
}
