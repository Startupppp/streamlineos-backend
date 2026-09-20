import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
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
import { FilesService } from "./files.service";
import {
  uploadFileSchema,
  listFilesQuerySchema,
  type UploadFileInput,
  type ListFilesQuery,
} from "./dto/files.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  fileRowSchema,
  fileListPageSchema,
  signedUrlResponseSchema,
} from "./dto/files-response.schemas";

const fileIdParams = z
  .object({ fileId: z.coerce.number().int().positive() })
  .strict();

@RequireModule("build")
@Controller("build/:projectId/files")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class FilesController {
  constructor(private readonly svc: FilesService) {}

  @Get()
  @RequirePermission("build:files:view")
  @ResponseSchema(fileListPageSchema)
  @Validate({ query: listFilesQuerySchema })
  listFiles(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: ListFilesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listFiles(u, projectId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:files:manage")
  @ResponseSchema(fileRowSchema)
  @Validate({ body: uploadFileSchema })
  uploadFile(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: UploadFileInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.uploadFile(u, projectId, body);
  }

  @Get(":fileId/url")
  @RequirePermission("build:files:view")
  @ResponseSchema(signedUrlResponseSchema)
  @Validate({ params: fileIdParams })
  getSignedUrl(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("fileId", ParseIntPipe) fileId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getSignedUrl(u, projectId, fileId);
  }

  @Delete(":fileId")
  @HttpCode(204)
  @RequirePermission("build:files:manage")
  @NoContentResponse()
  @Validate({ params: fileIdParams })
  softDeleteFile(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("fileId", ParseIntPipe) fileId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.softDeleteFile(u, projectId, fileId);
  }
}
