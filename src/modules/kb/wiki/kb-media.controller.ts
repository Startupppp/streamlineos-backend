import {
  BadRequestException,
  Body,
  Controller,
  Post,
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
import { KbMediaService, type KbMediaUploadResult } from "./kb-media.service";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { MultipartAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { kbMediaUploadSchema } from "./dto/kb-wiki-response.schemas";

const MAX_FILE_SIZE = 100 * 1024 * 1024;

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbMediaController {
  constructor(private readonly media: KbMediaService) {}

  /**
   * `@Idempotent` for the same reason `POST /kb/sources` carries one, and the
   * dedupe that looks like it already covers this does not.
   *
   * Every attempt calls `StorageService.uploadFile`, which mints a FRESH object key,
   * so the `onConflictDoNothing` on `(org_id, file_key)` in `KbMediaService.upload`
   * can never match a retry — it dedupes the same key, and a retry never has the
   * same key. A 100 MB video re-sent after the client's timeout is therefore a
   * second billed object in the R2 bucket that nothing will ever reference, and for
   * a `DOC_TYPES` upload against a page it is also a second full
   * `indexPageDocument` run: another extract and another billed embed batch over
   * the same bytes.
   *
   * `check:idempotent-commands` is green over this route and always was — its scope
   * is a keyword list (`checkout|purchase|payout|…|publish|approve|…`) that matches
   * no AI-metered or storage-metered KB route. Widening that list is not the fix;
   * fencing the route is.
   */
  @Post("media")
  @MultipartAction({ file: "file", fields: { pageId: "string" } })
  @Idempotent("kb.media.upload")
  @RequirePermission("kb:pages:update")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_FILE_SIZE } }))
  @ResponseSchema(kbMediaUploadSchema)
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() u: CurrentUserContext,
    @Body("pageId") rawPageId?: string,
  ): Promise<KbMediaUploadResult> {
    if (!file) throw new BadRequestException("No file provided");
    const parsed = rawPageId ? Number(rawPageId) : undefined;
    const pageId = parsed !== undefined && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    return this.media.upload(file, u, pageId);
  }
}
