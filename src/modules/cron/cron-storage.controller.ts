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
import { CronLeaseService } from "./cron-lease.service";
import { CronStorageSweepService } from "./cron-storage-sweep.service";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { storageSweepResponseSchema } from "../storage/dto/storage-response.schemas";

@Public()
@Controller("cron")
export class CronStorageController {
  constructor(
    private readonly storageSweep: CronStorageSweepService,
    private readonly cronLease: CronLeaseService,
  ) {}

  @Get("storage-sweep")
  @ResponseSchema(storageSweepResponseSchema)
  getStorageSweep(@Headers("authorization") authorization?: string) {
    return this.runStorageSweep(authorization);
  }

  @Post("storage-sweep")
  @ResponseSchema(storageSweepResponseSchema)
  @BodylessAction()
  @HttpCode(200)
  postStorageSweep(@Headers("authorization") authorization?: string) {
    return this.runStorageSweep(authorization);
  }

  private async runStorageSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("storage-sweep", 1800, () =>
        this.storageSweep.sweep(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "storage-sweep already running" };
      return { success: true, ...outcome.result };
    } catch (error) {
      logger.error("Storage sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
