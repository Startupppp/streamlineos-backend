import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { checkWebhookUrl } from "../../common/security/ssrf-guard";
import { NoTenantTransaction } from "../../common/tenant/no-tenant-transaction.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { linkPreviewQuerySchema, type LinkPreviewQueryInput } from "./dto/chat-link-preview.schemas";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { chatLinkPreviewSchema } from "./dto/chat-misc-response.schemas";

const MAX_PREVIEW_BYTES = 512 * 1024;

interface LinkMeta {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

@ApiTags("Chat Link Preview")
@ApiBearerAuth()
@Controller("chat/link-preview")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatLinkPreviewController {
  @ApiOperation({ summary: "Fetch Open Graph metadata for a URL to render a link preview card" })
  @ApiResponse({ status: 200, description: "Link metadata" })
  @Get()
  @NoTenantTransaction()
  @ResponseSchema(chatLinkPreviewSchema)
  @RequirePermission("chat:messages:read")
  @Validate({ query: linkPreviewQuerySchema })
  async preview(@Query() query: LinkPreviewQueryInput): Promise<LinkMeta> {
    const { url } = query;
    const empty: LinkMeta = { url, title: null, description: null, image: null, siteName: null };

    const check = await checkWebhookUrl(url);
    if (!check.allowed) return empty;

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "StreamlineOS/1.0 LinkPreview" },
        signal: AbortSignal.timeout(4000),
        redirect: "manual",
      });
      const html = (await res.text()).slice(0, MAX_PREVIEW_BYTES);
      const getMeta = (name: string) => {
        const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"))
          ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, "i"));
        return m?.[1] ?? null;
      };
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      return {
        url,
        title: getMeta("og:title") ?? titleMatch?.[1]?.trim() ?? null,
        description: getMeta("og:description") ?? getMeta("description") ?? null,
        image: getMeta("og:image") ?? null,
        siteName: getMeta("og:site_name") ?? new URL(url).hostname,
      };
    } catch {
      return { url, title: null, description: null, image: null, siteName: (() => { try { return new URL(url).hostname; } catch { return null; } })() };
    }
  }
}
