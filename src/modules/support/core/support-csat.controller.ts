import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Param, Post, Request, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { Public } from "../../../common/auth/public.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { SupportCsatService } from "./support-csat.service";
import { submitCsatSchema, type SubmitCsatInput } from "./dto/support.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RateLimitService } from "../../../common/ratelimit/rate-limit.service";

const tokenParams = z.object({ token: z.string().min(1) }).strict();

@RequireModule("support")
@Controller("support")
export class SupportCsatController {
  constructor(
    private readonly csat: SupportCsatService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private getIp(req: { ip?: string; headers: Record<string, string> }): string {
    return req.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ?? req.ip ?? "unknown";
  }

  private async enforceRateLimit(tier: string, identifier: string): Promise<void> {
    const result = await this.rateLimit.check(tier, identifier);
    if (!result.allowed)
      throw new HttpException({ message: "Too many requests. Try again later." }, HttpStatus.TOO_MANY_REQUESTS);
  }

  @Get("reports/csat")
  @UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
  @RequirePermission("support:reports:view")
  getCsatReport(@CurrentUser() u: CurrentUserContext) {
    return this.csat.getReport(u.orgId);
  }

  /** Public — the customer follows an emailed link with no session. */
  @Public()
  @Get("csat/:token")
  @Validate({ params: tokenParams })
  async getCsatRequest(
    @Param("token") token: string,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("support:csat-view", this.getIp(req));
    return this.csat.getByToken(token);
  }

  @Public()
  @Post("csat/:token")
  @HttpCode(200)
  @Validate({ params: tokenParams, body: submitCsatSchema })
  async submitCsat(
    @Param("token") token: string,
    @Body() body: SubmitCsatInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("support:csat-submit", this.getIp(req));
    return this.csat.submit(token, body);
  }
}
