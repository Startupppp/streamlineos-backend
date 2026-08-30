import { Body, Controller, HttpCode, HttpException, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "../../common/auth/api-key.guard";
import { ApiKey, type ApiKeyContext } from "../../common/auth/api-key.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { ingestSchema, type IngestInput } from "./dto/lead.schemas";
import { LeadsService } from "./leads.service";
import { Public } from "../../common/auth/public.decorator";

@Public()
@Controller("leads/ingest")
@UseGuards(ApiKeyGuard)
export class LeadsIngestController {
  constructor(private readonly leads: LeadsService) {}

  @Post()
  @HttpCode(201)
  @Validate({ body: ingestSchema })
  async ingest(@Body() body: IngestInput, @ApiKey() key: ApiKeyContext) {
    if (!body.name && !body.email && !body.phone) {
      throw new HttpException(
        "At least one of name, email, or phone is required",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return this.leads.ingestCreate(key.orgId, body);
  }
}
