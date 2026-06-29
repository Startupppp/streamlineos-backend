import { Body, Controller, HttpCode, HttpException, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "../../common/auth/api-key.guard";
import { ApiKey, type ApiKeyContext } from "../../common/auth/api-key.decorator";
import { ingestSchema } from "./dto/lead.schemas";
import { LeadsService } from "./leads.service";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("crm")
@Controller("leads/ingest")
@UseGuards(ApiKeyGuard)
export class LeadsIngestController {
  constructor(private readonly leads: LeadsService) {}

  @Post()
  @HttpCode(201)
  async ingest(@Body() rawBody: unknown, @ApiKey() key: ApiKeyContext) {
    const parsed = ingestSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new HttpException(
        parsed.error.issues[0]?.message ?? "Invalid request body",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const body = parsed.data;
    if (!body.name && !body.email && !body.phone) {
      throw new HttpException(
        "At least one of name, email, or phone is required",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return this.leads.ingestCreate(key.orgId, body);
  }
}
