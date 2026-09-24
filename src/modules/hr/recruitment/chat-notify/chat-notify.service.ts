import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { candidates, jobPostings } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { logger } from "../../../../common/logger/logger.service";
import { ProviderCredentialsService } from "../integrations/provider-credentials.service";
import {
  buildInterviewNotice,
  CHAT_PLATFORMS,
  noticeLeaksSomething,
  resolveChat,
} from "./interview-notice";

export interface InterviewNotifyInput {
  interviewId: number;
  candidateId: number;
  jobPostingId: number | null;
  scheduledAt: Date;
  durationMinutes: number;
  kind: "assigned" | "rescheduled" | "cancelled";
}

@Injectable()
export class ChatNotifyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly credentials: ProviderCredentialsService,
  ) {}

  /**
   * Tells an interviewer's chat workspace about an interview.
   *
   * Never throws. The interview is already scheduled by the time this runs, the
   * interviewer already has the email and the calendar invite, and a chat
   * workspace being unreachable must not fail the request that created it. Every
   * failure ends in a log line naming the interview.
   */
  async notifyInterview(orgId: string, input: InterviewNotifyInput): Promise<{ sent: number }> {
    try {
      const [candidate, job] = await Promise.all([
        this.db.query.candidates.findFirst({
          where: and(eq(candidates.id, input.candidateId), eq(candidates.orgId, orgId)),
          /*
            First name only. Everything else on this row — surname, email,
            phone, notes, scores — is one column list away and none of it
            belongs in a channel whose membership this product does not control.
          */
          columns: { firstName: true },
        }),
        input.jobPostingId === null
          ? Promise.resolve(undefined)
          : this.db.query.jobPostings.findFirst({
              where: and(
                eq(jobPostings.id, input.jobPostingId),
                eq(jobPostings.orgId, orgId),
              ),
              columns: { title: true },
            }),
      ]);

      const message = buildInterviewNotice({
        candidateFirstName: candidate?.firstName ?? "A candidate",
        jobTitle: job?.title ?? "an open role",
        whenText: formatForOrg(input.scheduledAt),
        durationMinutes: input.durationMinutes,
        scorecardPath: `/hr/recruitment/interviews/${input.interviewId}`,
        kind: input.kind,
      });

      /*
        The guard runs on the built message, not on the inputs. Widening what
        goes into the builder is a one-line edit and nothing else in the system
        would notice; this is the thing that would.
      */
      const leak = noticeLeaksSomething(message);
      if (leak) {
        logger.error("[chat-notify] refusing to post a notice that carries candidate detail", {
          orgId,
          interviewId: input.interviewId,
          matched: leak,
        });
        return { sent: 0 };
      }

      let sent = 0;
      for (const platform of CHAT_PLATFORMS) {
        const credentials = await this.credentials.forPlatform(orgId, platform);
        const resolved = resolveChat(platform, credentials);
        if (!("adapter" in resolved)) continue;
        await resolved.adapter.post(resolved.credentials, message);
        sent += 1;
      }
      return { sent };
    } catch (error: unknown) {
      logger.error("[chat-notify] interview notice not delivered", {
        orgId,
        interviewId: input.interviewId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { sent: 0 };
    }
  }
}

/**
 * IST, because that is where this product's tenants hire.
 *
 * Fixed rather than read from an org setting: there is no per-org timezone
 * column to read, and inventing one here would be a setting nobody could
 * change. A recruiter reading "3:00 pm IST" knows what they are looking at,
 * which an unlabelled local time does not give them.
 */
function formatForOrg(when: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  }).format(when) + " IST";
}
