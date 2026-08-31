import { Controller, Get, HttpException, HttpStatus, NotFoundException, Param, Request } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../../../common/auth/public.decorator";
import { KbPagesService } from "./kb-pages.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { RateLimitService } from "../../../common/ratelimit/rate-limit.service";

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
  async getPublicPage(
    @Param("token") token: string,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ): Promise<unknown> {
    const ip = req.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ?? req.ip ?? "unknown";
    const result = await this.rateLimit.check("public:kb", ip);
    if (!result.allowed)
      throw new HttpException({ message: "Too many requests. Try again later." }, HttpStatus.TOO_MANY_REQUESTS);
    const parsed = tokenParamSchema.safeParse(token);
    if (!parsed.success) throw new NotFoundException("Page not found");
    return this.pages.getPublicPage(parsed.data);
  }
}