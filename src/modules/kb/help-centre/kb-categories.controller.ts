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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbCategoriesService } from "./kb-categories.service";
import {
  createCategorySchema,
  updateCategorySchema,
  type CreateCategoryInput,
  type UpdateCategoryInput,
} from "../core/dto/kb.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  kbCategoryListSchema,
  kbCategorySchema,
  kbCategorySuccessSchema,
} from "./dto/kb-helpcenter-response.schemas";
import { z } from "zod";

const spaceIdParams = z.object({ spaceId: z.coerce.number().int().positive() }).strict();
const categoryIdParams = z.object({ categoryId: z.coerce.number().int().positive() }).strict();

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbCategoriesController {
  constructor(private readonly categories: KbCategoriesService) {}

  @Get("spaces/:spaceId/categories")
  @RequirePermission("kb:spaces:view")
  @Validate({ params: spaceIdParams })
  @ResponseSchema(kbCategoryListSchema)
  async list(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.categories.listBySpace(u, spaceId);
  }

  @Post("spaces/:spaceId/categories")
  @RequirePermission("kb:categories:manage")
  @HttpCode(201)
  @Validate({ params: spaceIdParams, body: createCategorySchema })
  @ResponseSchema(kbCategorySchema)
  async create(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @Body() body: CreateCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.categories.create(u, spaceId, body);
  }

  @Patch("categories/:categoryId")
  @RequirePermission("kb:categories:manage")
  @Validate({ params: categoryIdParams, body: updateCategorySchema })
  @ResponseSchema(kbCategorySchema)
  async update(
    @Param("categoryId", ParseIntPipe) categoryId: number,
    @Body() body: UpdateCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.categories.update(u, categoryId, body);
  }

  @Delete("categories/:categoryId")
  @RequirePermission("kb:categories:manage")
  @Validate({ params: categoryIdParams })
  @ResponseSchema(kbCategorySuccessSchema)
  async remove(
    @Param("categoryId", ParseIntPipe) categoryId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.categories.remove(u.orgId, categoryId);
  }
}
