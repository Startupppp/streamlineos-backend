import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
} from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CareersService, isApplyJobNotFound } from "./careers.service";
import { applySchema, type ApplyInput } from "./dto/careers.schemas";

@Controller("careers")
export class CareersController {
  constructor(private readonly careers: CareersService) {}

  @Public()
  @Get()
  list() {
    return this.careers.listOpenJobs();
  }

  @Public()
  @Post("apply")
  @HttpCode(201)
  async apply(@Body(new ZodValidationPipe(applySchema)) body: ApplyInput) {
    const result = await this.careers.apply(body);
    if (isApplyJobNotFound(result)) {
      throw new NotFoundException(
        "Job posting not found or is no longer accepting applications.",
      );
    }
    return result;
  }
}
