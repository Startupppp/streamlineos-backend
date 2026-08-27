import { Controller, Get, Inject } from "@nestjs/common";
import { Universal } from "../../common/auth/universal.decorator";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";

interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

@Controller("realtime")
export class RealtimeController {
  constructor(
    @Inject(APP_CONFIG)
    private readonly config: Pick<AppConfig, "TURN_URLS" | "TURN_USERNAME" | "TURN_CREDENTIAL">,
  ) {}

  @Get("ice-servers")
  @Universal()
  iceServers(): { iceServers: IceServer[] } {
    const servers: IceServer[] = [
      { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    ];
    const turnUrls = (this.config.TURN_URLS ?? "")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    if (turnUrls.length > 0)
      servers.push({
        urls: turnUrls,
        username: this.config.TURN_USERNAME,
        credential: this.config.TURN_CREDENTIAL,
      });
    return { iceServers: servers };
  }
}
