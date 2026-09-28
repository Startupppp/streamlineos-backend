import { Controller, Get, HttpException, HttpStatus, NotFoundException, Param, Query, Res, Request } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { Public } from "../../../common/auth/public.decorator";
import { KbPagePublicService } from "./kb-page-public.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { RateLimitService } from "../../../common/ratelimit/rate-limit.service";
import { resolveClientIpOr } from "../../../common/http/client-ip";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { kbPublicPageSchema } from "./dto/kb-wiki-response.schemas";
import { StorageService } from "../../storage/storage.service";

const tokenParams = z.object({ token: z.string().min(1) }).strict();

const tokenParamSchema = z.string().max(64).regex(/^[a-zA-Z0-9-]+$/);

const mediaKeySchema = z.string().min(1).max(1024);

const mediaQuerySchema = z.object({ key: z.string().min(1).max(1024) }).strict();

const kbPublicMediaBrokerSchema = z.object({ redirected: z.literal(true) });

export const KB_PUBLIC_MEDIA_URL_TTL_SECONDS = 300;

@Public()
@Controller("public/wiki")
export class KbPublicPagesController {
  constructor(
    private readonly pages: KbPagePublicService,
    private readonly rateLimit: RateLimitService,
    private readonly storage: StorageService,
  ) {}

  @Get(":token")
  @Validate({ params: tokenParams })
  @ResponseSchema(kbPublicPageSchema)
  async getPublicPage(
    @Param("token") token: string,
    @Request() req: { ip?: string; headers: Record<string, string> },
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const ip = resolveClientIpOr(req, "unknown");
    const result = await this.rateLimit.check("public:kb", ip);
    if (!result.allowed)
      throw new HttpException({ message: "Too many requests. Try again later." }, HttpStatus.TOO_MANY_REQUESTS);
    const parsed = tokenParamSchema.safeParse(token);
    if (!parsed.success) throw new NotFoundException("Page not found");
    const { publicTokenRevision, ...page } = await this.pages.getPublicPage(parsed.data);
    res.setHeader("ETag", `"${page.updatedAt.getTime()}-${publicTokenRevision}"`);
    res.setHeader("Cache-Control", "public, no-cache");
    return page;
  }

  @Get(":token/media")
  @Validate({ params: tokenParams, query: mediaQuerySchema })
  @ResponseSchema(kbPublicMediaBrokerSchema)
  async getPublicMedia(
    @Param("token") token: string,
    @Query("key") key: string,
    @Request() req: { ip?: string; headers: Record<string, string> },
    @Res() res: Response,
  ): Promise<void> {
    const ip = resolveClientIpOr(req, "unknown");
    const rateLimitResult = await this.rateLimit.check("public:kb", ip);
    if (!rateLimitResult.allowed)
      throw new HttpException({ message: "Too many requests. Try again later." }, HttpStatus.TOO_MANY_REQUESTS);
    const parsedToken = tokenParamSchema.safeParse(token);
    if (!parsedToken.success) throw new NotFoundException("Page not found");
    const parsedKey = mediaKeySchema.safeParse(key);
    if (!parsedKey.success) throw new NotFoundException("Attachment not found");
    const grant = await this.pages.validatePublicAttachment(parsedToken.data, parsedKey.data);
    const signedUrl = await this.storage.getFileUrl(
      grant.orgId,
      grant.fileKey,
      KB_PUBLIC_MEDIA_URL_TTL_SECONDS,
      undefined,
      { preauthorized: true },
    );
    res.redirect(302, signedUrl);
  }
}