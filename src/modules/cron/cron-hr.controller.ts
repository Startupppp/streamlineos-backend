import {
  Controller,
  Get,
  Headers,
  HttpCode,
  InternalServerErrorException,
  Param,
  Post,
} from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { logger } from "../../common/logger/logger.service";
import { assertCronSecret } from "./cron-secret";
import { CronAttendanceService } from "./cron-attendance.service";
import { CronLeaveService } from "./cron-leave.service";
import { CronHrService } from "./cron-hr.service";
import { CronHrEnginesService } from "./cron-hr-engines.service";
import { CronRecruitmentService } from "./cron-recruitment.service";
import { CronRecruitmentSequencesService } from "./cron-recruitment-sequences.service";
import { CronRecruitmentSlaService } from "./cron-recruitment-sla.service";
import { CronRecruitmentReportsService } from "./cron-recruitment-reports.service";
import { CronHrWebhookDispatchService } from "./cron-hr-webhook-dispatch.service";
import { CronLeaseService } from "./cron-lease.service";
import { CronHrRetentionService } from "./cron-hr-retention.service";
import { CronHelpdeskRetentionService } from "./cron-helpdesk-retention.service";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import {
  autoCheckoutResponseSchema,
  monthlyLeaveResetResponseSchema,
  interviewNoShowsResponseSchema,
  onboardingSweepResponseSchema,
  hrEnginesSweepResponseSchema,
  hrEnginesSweepByNameResponseSchema,
  retentionDeleteSweepResponseSchema,
  hrPolicyRetentionSweepResponseSchema,
  helpdeskRetentionSweepResponseSchema,
  hrWebhookSweepResponseSchema,
  recruitmentSequenceStepsResponseSchema,
  recruitmentSlaSweepResponseSchema,
  recruitmentScheduledReportsResponseSchema,
} from "./dto/cron-hr-response.schemas";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";

const sweepNameParams = z.object({ sweepName: z.string().min(1) }).strict();

@Public()
@Controller("cron")
export class CronHrController {
  constructor(
    private readonly attendance: CronAttendanceService,
    private readonly leave: CronLeaveService,
    private readonly recruitment: CronRecruitmentService,
    private readonly sequences: CronRecruitmentSequencesService,
    private readonly recruitmentSla: CronRecruitmentSlaService,
    private readonly recruitmentReports: CronRecruitmentReportsService,
    private readonly hr: CronHrService,
    private readonly hrEngines: CronHrEnginesService,
    private readonly hrWebhookDispatch: CronHrWebhookDispatchService,
    private readonly cronLease: CronLeaseService,
    private readonly hrRetention: CronHrRetentionService,
    private readonly helpdeskRetention: CronHelpdeskRetentionService,
  ) {}

  @Get("auto-checkout")
  @ResponseSchema(autoCheckoutResponseSchema)
  getAutoCheckout(@Headers("authorization") authorization?: string) {
    return this.runAutoCheckout(authorization);
  }

  @Post("auto-checkout")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(autoCheckoutResponseSchema)
  postAutoCheckout(@Headers("authorization") authorization?: string) {
    return this.runAutoCheckout(authorization);
  }

  @Get("monthly-leave-reset")
  @ResponseSchema(monthlyLeaveResetResponseSchema)
  getMonthlyLeaveReset(@Headers("authorization") authorization?: string) {
    return this.runMonthlyLeaveReset(authorization);
  }

  @Post("monthly-leave-reset")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(monthlyLeaveResetResponseSchema)
  postMonthlyLeaveReset(@Headers("authorization") authorization?: string) {
    return this.runMonthlyLeaveReset(authorization);
  }

  @Get("interview-no-shows")
  @ResponseSchema(interviewNoShowsResponseSchema)
  getInterviewNoShows(@Headers("authorization") authorization?: string) {
    return this.runInterviewNoShows(authorization);
  }

  @Post("interview-no-shows")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(interviewNoShowsResponseSchema)
  postInterviewNoShows(@Headers("authorization") authorization?: string) {
    return this.runInterviewNoShows(authorization);
  }

  @Get("recruitment-sequence-steps")
  @ResponseSchema(recruitmentSequenceStepsResponseSchema)
  getRecruitmentSequenceSteps(@Headers("authorization") authorization?: string) {
    return this.runRecruitmentSequenceSteps(authorization);
  }

  @Post("recruitment-sequence-steps")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(recruitmentSequenceStepsResponseSchema)
  postRecruitmentSequenceSteps(@Headers("authorization") authorization?: string) {
    return this.runRecruitmentSequenceSteps(authorization);
  }

  @Get("recruitment-sla-sweep")
  @ResponseSchema(recruitmentSlaSweepResponseSchema)
  getRecruitmentSlaSweep(@Headers("authorization") authorization?: string) {
    return this.runRecruitmentSlaSweep(authorization);
  }

  @Post("recruitment-sla-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(recruitmentSlaSweepResponseSchema)
  postRecruitmentSlaSweep(@Headers("authorization") authorization?: string) {
    return this.runRecruitmentSlaSweep(authorization);
  }

  @Get("recruitment-scheduled-reports")
  @ResponseSchema(recruitmentScheduledReportsResponseSchema)
  getRecruitmentScheduledReports(@Headers("authorization") authorization?: string) {
    return this.runRecruitmentScheduledReports(authorization);
  }

  @Post("recruitment-scheduled-reports")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(recruitmentScheduledReportsResponseSchema)
  postRecruitmentScheduledReports(@Headers("authorization") authorization?: string) {
    return this.runRecruitmentScheduledReports(authorization);
  }

  @Get("onboarding-sweep")
  @ResponseSchema(onboardingSweepResponseSchema)
  getOnboardingSweep(@Headers("authorization") authorization?: string) {
    return this.runOnboardingSweep(authorization);
  }

  @Post("onboarding-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(onboardingSweepResponseSchema)
  postOnboardingSweep(@Headers("authorization") authorization?: string) {
    return this.runOnboardingSweep(authorization);
  }

  @Post("hr-engines-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(hrEnginesSweepResponseSchema)
  postHrEnginesSweep(@Headers("authorization") authorization?: string) {
    return this.runHrEnginesSweep(authorization);
  }

  @Get("hr-engines-sweep")
  @ResponseSchema(hrEnginesSweepResponseSchema)
  getHrEnginesSweep(@Headers("authorization") authorization?: string) {
    return this.runHrEnginesSweep(authorization);
  }

  @Post("hr-engines-sweep/:sweepName")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(hrEnginesSweepByNameResponseSchema)
  @Validate({ params: sweepNameParams })
  postHrEnginesSweepByName(
    @Headers("authorization") authorization?: string,
    @Param("sweepName") sweepName?: string,
  ) {
    return this.runHrEnginesSweepByName(authorization, sweepName);
  }

  @Get("hr-engines-sweep/:sweepName")
  @ResponseSchema(hrEnginesSweepByNameResponseSchema)
  @Validate({ params: sweepNameParams })
  getHrEnginesSweepByName(
    @Headers("authorization") authorization?: string,
    @Param("sweepName") sweepName?: string,
  ) {
    return this.runHrEnginesSweepByName(authorization, sweepName);
  }

  @Post("hr-webhook-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(hrWebhookSweepResponseSchema)
  postHrWebhookSweep(@Headers("authorization") authorization?: string) {
    return this.runHrWebhookSweep(authorization);
  }

  @Get("hr-webhook-sweep")
  @ResponseSchema(hrWebhookSweepResponseSchema)
  getHrWebhookSweep(@Headers("authorization") authorization?: string) {
    return this.runHrWebhookSweep(authorization);
  }

  private async runHrWebhookSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("hr-webhook-dispatch-sweep", 300, () =>
        this.hrWebhookDispatch.sweep(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "hr-webhook-dispatch-sweep already running" };
      return { success: true, message: "HR webhook sweep complete" };
    } catch (error) {
      logger.error("HR webhook sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runAutoCheckout(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("auto-checkout", 300, () =>
        this.attendance.processAutoCheckout(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "auto-checkout already running" };
      return { success: true, ...outcome.result };
    } catch (error) {
      logger.error("Auto-checkout cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runMonthlyLeaveReset(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("monthly-leave-reset", 300, () =>
        this.leave.runMonthlyLeaveReset(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "monthly-leave-reset already running" };
      const result = outcome.result;
      return {
        success: true,
        monthlyExpiry: result.monthlyExpiry,
        yearlyReset: result.yearlyReset,
      };
    } catch (error) {
      logger.error("Monthly leave reset cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runInterviewNoShows(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("interview-no-shows", 300, () =>
        this.recruitment.processInterviewNoShows(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "interview-no-shows already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Processed ${result.processedCount} interview no-shows`,
        ...result,
      };
    } catch (error) {
      logger.error("Interview no-show cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runRecruitmentSequenceSteps(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("recruitment-sequence-steps", 300, () =>
        this.sequences.sendDueSequenceSteps(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "recruitment-sequence-steps already running" };
      return { success: true, ...outcome.result };
    } catch (error) {
      logger.error("Recruitment sequence step cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runRecruitmentSlaSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("recruitment-sla-sweep", 300, () =>
        this.recruitmentSla.sweepStageSlas(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "recruitment-sla-sweep already running" };
      return { success: true, ...outcome.result };
    } catch (error) {
      logger.error("Recruitment SLA sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runRecruitmentScheduledReports(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("recruitment-scheduled-reports", 600, () =>
        this.recruitmentReports.deliverDueReports(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "recruitment-scheduled-reports already running" };
      return { success: true, ...outcome.result };
    } catch (error) {
      logger.error("Recruitment scheduled report cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runOnboardingSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("onboarding-sweep", 300, () =>
        this.hr.processOnboardingCompletionSweep(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "onboarding-sweep already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Dispatched ${result.fired} onboarding completion events`,
        ...result,
      };
    } catch (error) {
      logger.error("Onboarding completion sweep failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runHrEnginesSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("hr-engines-sweep", 600, () =>
        this.hrEngines.runAll(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "hr-engines-sweep already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `HR engines sweep complete: ${result.succeeded} succeeded, ${result.failed} failed across ${result.orgsProcessed} orgs`,
        ...result,
      };
    } catch (error) {
      logger.error("HR engines sweep (all) cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  @Post("retention-delete-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(retentionDeleteSweepResponseSchema)
  postRetentionDeleteSweep(@Headers("authorization") authorization?: string) {
    return this.runRetentionDeleteSweep(authorization);
  }

  @Get("retention-delete-sweep")
  @ResponseSchema(retentionDeleteSweepResponseSchema)
  getRetentionDeleteSweep(@Headers("authorization") authorization?: string) {
    return this.runRetentionDeleteSweep(authorization);
  }

  private async runRetentionDeleteSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("retention-delete-sweep", 600, () =>
        this.hr.sweepRetentionDeleteRequests(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "retention-delete-sweep already running" };
      return { success: true, ...outcome.result };
    } catch (error) {
      logger.error("Retention delete sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  @Get("hr-policy-retention-sweep")
  @ResponseSchema(hrPolicyRetentionSweepResponseSchema)
  getHrPolicyRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runHrPolicyRetentionSweep(authorization);
  }

  @Post("hr-policy-retention-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(hrPolicyRetentionSweepResponseSchema)
  postHrPolicyRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runHrPolicyRetentionSweep(authorization);
  }

  private async runHrPolicyRetentionSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("hr-policy-retention-sweep", 1800, () =>
        this.hrRetention.sweep(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "hr-policy-retention-sweep already running" };
      const result = outcome.result;
      return {
        success: true,
        message:
          `HR policy retention: ${result.employeeSoftDeleted} employees, ` +
          `${result.caseSoftDeleted} cases, ${result.attendanceDeleted} attendance rows across ${result.organizations} orgs`,
        ...result,
      };
    } catch (error) {
      logger.error("HR policy retention sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  @Get("helpdesk-retention-sweep")
  @ResponseSchema(helpdeskRetentionSweepResponseSchema)
  getHelpdeskRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runHelpdeskRetentionSweep(authorization);
  }

  @Post("helpdesk-retention-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(helpdeskRetentionSweepResponseSchema)
  postHelpdeskRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runHelpdeskRetentionSweep(authorization);
  }

  private async runHelpdeskRetentionSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("helpdesk-retention-sweep", 1800, () =>
        this.helpdeskRetention.sweep(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "helpdesk-retention-sweep already running" };
      const result = outcome.result;
      return {
        success: true,
        message:
          `Helpdesk retention: ${result.ticketsDeleted} tickets deleted across ${result.organizations} orgs`,
        ...result,
      };
    } catch (error) {
      logger.error("Helpdesk retention sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runHrEnginesSweepByName(
    authorization?: string,
    sweepName?: string,
  ) {
    assertCronSecret(authorization);
    try {
      if (sweepName === "workflow-sla") {
        const outcome = await this.cronLease.withLease(
          `hr-engines-sweep.workflow-sla`,
          300,
          () => this.hrEngines.sweepWorkflowSlaEscalations(),
        );
        if (!outcome.ran) return { success: true, skipped: true, message: "hr-engines-sweep/workflow-sla already running" };
        return {
          success: true,
          message: `Swept ${outcome.result.swept} overdue workflow steps`,
          ...outcome.result,
        };
      }
      return {
        success: false,
        message: `Unknown sweep name: ${sweepName ?? ""}`,
      };
    } catch (error) {
      logger.error(
        `HR engines sweep (${sweepName ?? "unknown"}) cron failed`,
        error,
      );
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
