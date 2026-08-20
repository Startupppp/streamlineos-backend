import { Inject, Injectable } from "@nestjs/common";
import { platformWaitlistSignups } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { WaitlistJoinInput } from "./dto/public.schemas";

export interface WaitlistRequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

const MAX_USER_AGENT_LENGTH = 500;
const DEFAULT_SOURCE = "landing";

@Injectable()
export class WaitlistService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async join(
    input: WaitlistJoinInput,
    meta: WaitlistRequestMeta,
  ): Promise<{ ok: true }> {
    const company = input.company?.trim();

    await this.db
      .insert(platformWaitlistSignups)
      .values({
        email: input.email.trim().toLowerCase(),
        name: input.name.trim(),
        company: company ? company : null,
        teamSize: input.teamSize ?? null,
        source: input.source ?? DEFAULT_SOURCE,
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
      })
      .onConflictDoNothing({ target: platformWaitlistSignups.email });

    return { ok: true };
  }
}
