import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { z } from "zod";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import { outboundTraceHeaders } from "../outbound/call-provider";

const turnstileResponseSchema = z.object({
  success: z.boolean(),
});

/**
 * Shared by every public form. Duplicating it once per form is how one of them
 * ends up without the check while still rendering the widget.
 */
@Injectable()
export class TurnstileService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async verify(
    token: string | undefined,
    clientIp: string | undefined,
  ): Promise<void> {
    const secret = this.config.TURNSTILE_SECRET_KEY?.trim();
    if (!secret) {
      if (this.config.NODE_ENV === "production") {
        throw new ServiceUnavailableException(
          "Bot verification is not configured",
        );
      }
      return;
    }
    if (!token) {
      throw new BadRequestException("Bot verification is required");
    }

    const body = new URLSearchParams({
      secret,
      response: token,
    });
    if (clientIp) body.set("remoteip", clientIp);

    let response: Response;
    try {
      response = await fetch(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        {
          method: "POST",
          headers: outboundTraceHeaders(),
          body,
          signal: AbortSignal.timeout(5000),
        },
      );
    } catch {
      throw new ServiceUnavailableException(
        "Bot verification is temporarily unavailable",
      );
    }

    if (!response.ok) {
      throw new ServiceUnavailableException(
        "Bot verification is temporarily unavailable",
      );
    }

    const parsed = turnstileResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ServiceUnavailableException(
        "Bot verification is temporarily unavailable",
      );
    }
    if (!parsed.data.success) {
      throw new BadRequestException("Bot verification failed");
    }
  }
}
