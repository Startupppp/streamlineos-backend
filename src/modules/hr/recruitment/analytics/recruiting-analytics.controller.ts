import { Controller, Get, Header, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { Validate } from "../../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { RecruitingAnalyticsService } from "./recruiting-analytics.service";
import { toCsv } from "./funnel-math";

/**
 * A window, capped at two years.
 *
 * The cap is not tidiness: the time-to-fill query groups over every accepted
 * application in the range, and an unbounded window on a large tenant is a
 * table scan behind a dashboard somebody reloads.
 */
const windowSchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .strict()
  .refine((q) => q.to.getTime() > q.from.getTime(), {
    message: "`to` must be after `from`.",
    path: ["to"],
  })
  .refine((q) => q.to.getTime() - q.from.getTime() <= 731 * 24 * 60 * 60 * 1000, {
    message: "Report over a window of two years or less.",
    path: ["to"],
  });
type WindowInput = z.infer<typeof windowSchema>;

const analyticsSchema = z.object({
  window: z.object({ from: z.date(), to: z.date() }),
  funnel: z.array(
    z.object({
      stage: z.string(),
      count: z.number().int(),
      conversionFromPrevious: z.number().nullable(),
      conversionFromTop: z.number().nullable(),
    }),
  ),
  timeToFillDays: z.object({
    count: z.number().int(),
    median: z.number().nullable(),
    p90: z.number().nullable(),
    mean: z.number().nullable(),
  }),
  sources: z.array(
    z.object({
      source: z.string(),
      applicants: z.number().int(),
      hires: z.number().int(),
      hireRate: z.number().nullable(),
    }),
  ),
  interviewerLoad: z.array(
    z.object({
      membershipId: z.number().int(),
      name: z.string(),
      scheduled: z.number().int(),
      completed: z.number().int(),
    }),
  ),
  offers: z.object({
    accepted: z.number().int(),
    declined: z.number().int(),
    outstanding: z.number().int(),
    acceptRate: z.number().nullable(),
  }),
  empty: z.boolean(),
});

@RequireModule("hr")
@Controller("hr/recruitment/analytics")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitingAnalyticsController {
  constructor(private readonly analytics: RecruitingAnalyticsService) {}

  @Get()
  @ResponseSchema(analyticsSchema)
  @RequirePermission("hr:requisitions:view")
  @Validate({ query: windowSchema })
  read(@Query() query: WindowInput, @CurrentUser() u: CurrentUserContext) {
    return this.analytics.forWindow(u.orgId, { from: query.from, to: query.to });
  }

  /**
   * The funnel as a file.
   *
   * Returns text rather than an envelope, so a browser saves it. The response
   * is built through `toCsv`, which neutralises a leading `=`, `+`, `-` or `@` —
   * a source label starting with one is executable content in a spreadsheet,
   * and the labels here include free text a candidate's own profile supplied.
   */
  @Get("funnel.csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="recruiting-funnel.csv"')
  @RequirePermission("hr:requisitions:view")
  @Validate({ query: windowSchema })
  async funnelCsv(@Query() query: WindowInput, @CurrentUser() u: CurrentUserContext) {
    const analytics = await this.analytics.forWindow(u.orgId, {
      from: query.from,
      to: query.to,
    });
    return toCsv(
      ["Stage", "Count", "Conversion from previous (%)", "Conversion from top (%)"],
      analytics.funnel.map((step) => [
        step.stage,
        step.count,
        step.conversionFromPrevious,
        step.conversionFromTop,
      ]),
    );
  }
}
