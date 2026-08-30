import { Controller, Get, HttpException, HttpStatus, Param, Request } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../../../common/auth/public.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { KbPagesService } from "./kb-pages.service";
import { RateLimitService } from "../../../common/ratelimit/rate-limit.service";

const tokenParams = z.object({ token: z.string().max(64).regex(/^[a-zA-Z0-9-]+$/) }).strict();

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
    return this.pages.getPublicPage(token);
  }
}
