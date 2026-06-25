import { BadRequestException, Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "../../common/auth/api-key.guard";
import { ApiKey, type ApiKeyContext } from "../../common/auth/api-key.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ingestSchema, type IngestInput } from "./dto/lead.schemas";
import { LeadsService } from "./leads.service";

@Controller("leads/ingest")
@UseGuards(ApiKeyGuard)
export class LeadsIngestController {
  constructor(private readonly leads: LeadsService) {}

  @Post()
  @HttpCode(201)
  async ingest(@Body(new ZodValidationPipe(ingestSchema)) body: IngestInput, @ApiKey() key: ApiKeyContext) {
    if (!body.name && !body.email && !body.phone) {
      throw new BadRequestException("At least one of name, email, or phone is required");
    }
    return this.leads.ingestCreate(key.orgId, body);
  }
}
