import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";

interface LinkMeta {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

@ApiTags("Chat Link Preview")
@ApiBearerAuth()
@RequireModule("chat")
@Controller("chat/link-preview")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatLinkPreviewController {
  @ApiOperation({ summary: "Fetch Open Graph metadata for a URL to render a link preview card" })
  @ApiResponse({ status: 200, description: "Link metadata" })
  @Get()
  @RequirePermission("chat:messages:read")
  async preview(@Query("url") url: string): Promise<LinkMeta> {
    if (!url || !url.startsWith("http")) return { url, title: null, description: null, image: null, siteName: null };
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "StreamlineOS/1.0 LinkPreview" },
        signal: AbortSignal.timeout(4000),
      });
      const html = await res.text();
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
