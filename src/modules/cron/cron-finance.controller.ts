import {
  Controller,
  Get,
  Headers,
  HttpCode,
  InternalServerErrorException,
  Post,
} from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { logger } from "../../common/logger/logger.service";
import { assertCronSecret } from "./cron-secret";
import { CronFinanceService } from "./cron-finance.service";
import { CronLeaseService } from "./cron-lease.service";
import {
  financeRecurringFlushResponseSchema,
  financeDueChecksResponseSchema,
  financeDepreciationResponseSchema,
} from "./dto/cron-build-response.schemas";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";

@Public()
@Controller("cron")
export class CronFinanceController {
  constructor(
    private readonly cronFinance: CronFinanceService,
    private readonly cronLease: CronLeaseService,
  ) {}

  @Get("finance-recurring-flush")
  @ResponseSchema(financeRecurringFlushResponseSchema)
  getFinanceRecurringFlush(@Headers("authorization") authorization?: string) {
    return this.runFinanceRecurringFlush(authorization);
  }

  @Post("finance-recurring-flush")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(financeRecurringFlushResponseSchema)
  postFinanceRecurringFlush(@Headers("authorization") authorization?: string) {
    return this.runFinanceRecurringFlush(authorization);
  }

  @Get("finance-due-checks")
  @ResponseSchema(financeDueChecksResponseSchema)
  getFinanceDueChecks(@Headers("authorization") authorization?: string) {
    return this.runFinanceDueChecks(authorization);
  }

  @Post("finance-due-checks")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(financeDueChecksResponseSchema)
  postFinanceDueChecks(@Headers("authorization") authorization?: string) {
    return this.runFinanceDueChecks(authorization);
  }

  @Get("finance-depreciation")
  @ResponseSchema(financeDepreciationResponseSchema)
  getFinanceDepreciation(@Headers("authorization") authorization?: string) {
    return this.runFinanceDepreciation(authorization);
  }

  @Post("finance-depreciation")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(financeDepreciationResponseSchema)
  postFinanceDepreciation(@Headers("authorization") authorization?: string) {
    return this.runFinanceDepreciation(authorization);
  }

  private async runFinanceRecurringFlush(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("finance-recurring-flush", 300, () =>
        this.cronFinance.runRecurringFlush(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "finance-recurring-flush already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Finance recurring flush: ${result.ran.join(", ")} — ${result.errors.length} error(s)`,
        ...result,
      };
    } catch (error) {
      logger.error("Finance recurring flush cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runFinanceDueChecks(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("finance-due-checks", 300, () =>
        this.cronFinance.runDueChecks(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "finance-due-checks already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Finance due checks: ${result.ran.join(", ")} — ${result.errors.length} error(s)`,
        ...result,
      };
    } catch (error) {
      logger.error("Finance due checks cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runFinanceDepreciation(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("finance-depreciation", 300, () =>
        this.cronFinance.runDepreciation(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "finance-depreciation already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Finance depreciation: ${result.ran.join(", ")} — ${result.errors.length} error(s)`,
        ...result,
      };
    } catch (error) {
      logger.error("Finance depreciation cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
