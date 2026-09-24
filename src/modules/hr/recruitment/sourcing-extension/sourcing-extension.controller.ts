import { Body, Controller, Get, Header, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { Validate } from "../../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { NO_COMPRESSION_HEADER } from "../../../../common/http/compression.config";
import { UserApiTokensService } from "../../../api-tokens/user/user-api-tokens.service";
import { SourcedProfileService } from "./sourced-profile.service";
import { SOURCING_PLATFORMS } from "./sourced-profile";
import {
  issueExtensionTokenSchema,
  lookupSourcedProfileSchema,
  saveSourcedProfileSchema,
  type IssueExtensionTokenInput,
  type LookupSourcedProfileInput,
  type SaveSourcedProfileInput,
} from "./sourced-profile.schemas";

/**
 * The one permission a sourcing token is allowed to carry.
 *
 * Deliberately a single key rather than the recruiter's whole standing: the
 * token lives in a browser extension on a laptop, and the blast radius of it
 * leaking should be "somebody can add candidates", not "somebody can read every
 * offer and salary in the pipeline".
 */
const EXTENSION_TOKEN_SCOPES = ["hr:requisitions:manage"] as const;

const extensionTokenSchema = z.object({
  token: z.string(),
  tokenId: z.string(),
  expiresAt: z.date(),
  scopes: z.array(z.string()),
});

const savedProfileSchema = z.object({
  candidateId: z.number().int(),
  outcome: z.enum(["created", "matched"]),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().nullable(),
  platform: z.enum(SOURCING_PLATFORMS),
  keptExisting: z.array(z.string()),
});

const profileLookupSchema = z.object({
  candidateId: z.number().int().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  status: z.string().nullable(),
});

@RequireModule("hr")
@Controller("hr/recruitment/sourcing")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SourcingExtensionController {
  constructor(
    private readonly profiles: SourcedProfileService,
    private readonly tokens: UserApiTokensService,
  ) {}

  /**
   * Exchanges the recruiter's signed-in session for a narrow, expiring token
   * the extension can hold.
   *
   * Gated on `settings:api-tokens:write` rather than a recruitment key, and
   * that is the load-bearing choice: `settings:` is in
   * `NON_DELEGABLE_PERMISSION_PREFIXES`, so a personal token resolves scope
   * "none" for it however it was minted. A stolen extension token therefore
   * cannot mint itself a successor, and expiry is a real deadline rather than
   * something a thief renews.
   *
   * `UserApiTokensService.create` refuses any scope the caller does not
   * themselves hold, so a recruiter without `hr:requisitions:manage` gets a 403
   * here instead of a token that would 403 on every later call.
   */
  @Post("extension-token")
  @HttpCode(201)
  @Header(NO_COMPRESSION_HEADER, "1")
  @ResponseSchema(extensionTokenSchema)
  @RequirePermission("settings:api-tokens:write")
  @Validate({ body: issueExtensionTokenSchema })
  async issueExtensionToken(
    @Body() body: IssueExtensionTokenInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const expiresAt = new Date(Date.now() + body.expiresInHours * 60 * 60 * 1000);
    const created = await this.tokens.create(u, {
      name: body.label,
      scopes: [...EXTENSION_TOKEN_SCOPES],
      expiresAt,
    });

    return {
      token: created.rawToken,
      tokenId: created.id,
      expiresAt,
      scopes: created.scopes,
    };
  }

  /**
   * Whether this profile is already in the org.
   *
   * The extension calls this on page load so its button can read "Already
   * saved" rather than offering to save somebody the recruiter is already
   * talking to.
   */
  @Get("profiles/lookup")
  @ResponseSchema(profileLookupSchema)
  @RequirePermission("hr:requisitions:view")
  @Validate({ query: lookupSourcedProfileSchema })
  lookupProfile(@Query() query: LookupSourcedProfileInput, @CurrentUser() u: CurrentUserContext) {
    return this.profiles.lookup(u.orgId, query.profileUrl);
  }

  /**
   * Saves what the recruiter can see on the page in front of them.
   *
   * Not idempotency-keyed, because the operation is idempotent by identity
   * instead: a second save of the same profile URL matches the first and fills
   * gaps rather than creating a second person. That holds across browsers and
   * across days, which a request-scoped idempotency key does not.
   */
  @Post("profiles")
  @HttpCode(201)
  @ResponseSchema(savedProfileSchema)
  @RequirePermission("hr:requisitions:manage")
  @Validate({ body: saveSourcedProfileSchema })
  saveProfile(@Body() body: SaveSourcedProfileInput, @CurrentUser() u: CurrentUserContext) {
    return this.profiles.save(u.orgId, u.userId, body);
  }
}
