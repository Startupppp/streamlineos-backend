import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "../../common/auth/api-key.guard";
import { ApiKey, type ApiKeyContext } from "../../common/auth/api-key.decorator";
import { ingestSchema, type IngestInput } from "./dto/lead.schemas";
import { LeadsService } from "./leads.service";
import { Public } from "../../common/auth/public.decorator";
import { Validate } from "../../common/validation/validate.decorator";

@Public()
@Controller("leads/ingest")
@UseGuards(ApiKeyGuard)
export class LeadsIngestController {
  constructor(private readonly leads: LeadsService) {}

  @Post()
  @HttpCode(201)
  @Validate({ body: ingestSchema })
  async ingest(@Body() body: IngestInput, @ApiKey() key: ApiKeyContext) {
    return this.leads.ingestCreate(key.orgId, body);
  }
}
