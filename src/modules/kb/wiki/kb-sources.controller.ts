import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbSourcesService } from "./kb-sources.service";
import {
  createKbSourceNoteSchema,
  kbSourcesListQuerySchema,
  type CreateKbSourceNoteInput,
  type KbSourcesListQuery,
} from "./dto/kb-sources.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { MultipartAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  kbSourcePageSchema,
  kbSourceSchema,
  kbSourceSuccessSchema,
} from "./dto/kb-wiki-response.schemas";
import { z } from "zod";

const sourceIdParams = z.object({ sourceId: z.coerce.number().int().positive() }).strict();

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbSourcesController {
  constructor(private readonly sources: KbSourcesService) {}

  @Get("sources")
  @RequirePermission("kb:pages:view")
  @Validate({ query: kbSourcesListQuerySchema })
  @ResponseSchema(kbSourcePageSchema)
  async list(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: KbSourcesListQuery,
  ) {
    return this.sources.list(u.orgId, query);
  }

  /**
   * `@Idempotent` because this route spends money and creates a row, and the retry that
   * causes both is the ordinary one: a 20 MB PDF on a phone, the client's 30s timeout
   * expiring while the server is still embedding, the user pressing upload again. Each POST
   * inserts a NEW `kb_sources` row, so the content-hash short-circuit that saves the page and
   * article paths cannot help — the second row is a different `sourceId` and therefore a
   * different chunk family. Two rows, two full embed batches billed, and `/kb/ask` citing the
   * same document twice.
   *
   * `check:idempotent-commands` reports "every in-scope mutating handler carries @Idempotent"
   * and did so with this route unfenced: its scope is a keyword list
   * (`checkout|purchase|payout|…|publish|approve|…`) that no AI-metered KB route matches. The
   * gate is green over a route it never looked at; that is worth knowing, not worth widening
   * here.
   */
  @Post("sources")
  @MultipartAction({ file: "file", fields: { spaceId: "string" } })
  @Idempotent("kb.source.create")
  @RequirePermission("kb:pages:create")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 25 * 1024 * 1024 } }))
  @HttpCode(201)
  @ResponseSchema(kbSourceSchema)
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() u: CurrentUserContext,
    @Body("spaceId") rawSpaceId?: string,
  ) {
    if (!file) throw new BadRequestException("No file provided");
    const parsed = rawSpaceId ? Number(rawSpaceId) : undefined;
    const spaceId =
      parsed !== undefined && Number.isInteger(parsed) && parsed > 0
        ? parsed
        : undefined;
    return this.sources.createFile(u, file, spaceId);
  }

  @Post("sources/note")
  @Idempotent("kb.source.note")
  @RequirePermission("kb:pages:create")
  @HttpCode(201)
  @Validate({ body: createKbSourceNoteSchema })
  @ResponseSchema(kbSourceSchema)
  async createNote(
    @Body() body: CreateKbSourceNoteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sources.createNote(u, body);
  }

  @Delete("sources/:sourceId")
  @RequirePermission("kb:pages:delete")
  @Validate({ params: sourceIdParams })
  @ResponseSchema(kbSourceSuccessSchema)
  async remove(
    @Param("sourceId", ParseIntPipe) sourceId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sources.remove(u.orgId, sourceId);
  }
}
