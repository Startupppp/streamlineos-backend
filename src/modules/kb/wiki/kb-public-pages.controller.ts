import { Controller, Get, HttpException, HttpStatus, NotFoundException, Param, Res, Request } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { Public } from "../../../common/auth/public.decorator";
import { KbPagesService } from "./kb-pages.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { RateLimitService } from "../../../common/ratelimit/rate-limit.service";
import { resolveClientIpOr } from "../../../common/http/client-ip";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { kbPublicPageSchema } from "./dto/kb-wiki-response.schemas";

const tokenParams = z.object({ token: z.string().min(1) }).strict();

const tokenParamSchema = z.string().max(64).regex(/^[a-zA-Z0-9-]+$/);

@Public()
@Controller("public/wiki")
export class KbPublicPagesController {
  constructor(
    private readonly pages: KbPagesService,
    private readonly rateLimit: RateLimitService,
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
}