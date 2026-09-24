import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../../common/auth/principal";
import { Validate } from "../../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { InterviewTranscriptService } from "./interview-transcript.service";
import { MAX_RETENTION_DAYS } from "./transcription-provider";

const interviewIdParams = z.object({ interviewId: z.coerce.number().int().positive() }).strict();

const storeTranscriptSchema = z
  .object({
    /**
     * Capped at 200k characters — roughly a six-hour interview at speaking
     * pace, and well past anything real. Uncapped, this column is a place to
     * park a file.
     */
    text: z.string().trim().min(1, "A transcript cannot be empty.").max(200_000),
    /**
     * `z.coerce.date()` with no default. A default would mean the server
     * inventing the moment a candidate consented, which is the one fact here
     * that must come from whoever was in the room.
     */
    consentAt: z.coerce.date(),
    retentionDays: z.coerce.number().int().min(1).max(MAX_RETENTION_DAYS).optional(),
  })
  .strict();
type StoreTranscriptInput = z.infer<typeof storeTranscriptSchema>;

const eraseTranscriptSchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();
type EraseTranscriptInput = z.infer<typeof eraseTranscriptSchema>;

const transcriptViewSchema = z.object({
  interviewId: z.number().int(),
  transcript: z.string().nullable(),
  source: z.enum(["MANUAL_UPLOAD", "PROVIDER"]).nullable(),
  consentAt: z.date().nullable(),
  retainUntil: z.date().nullable(),
  storedAt: z.date().nullable(),
  providerBlockedReason: z.string().nullable(),
});

/**
 * The transcript is the candidate's own words, so every route here is gated on
 * `hr:interviews:manage` rather than the `view` key the rest of the interview
 * uses — including the read.
 *
 * That asymmetry is deliberate. Anyone who can see an interview can see its
 * outcome and its scorecard; a verbatim record of what somebody said in a room
 * is a different thing, and reading one is audited.
 */
@RequireModule("hr")
@Controller("hr/recruitment/interviews/:interviewId/transcript")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class InterviewTranscriptController {
  constructor(private readonly transcripts: InterviewTranscriptService) {}

  @Get()
  @ResponseSchema(transcriptViewSchema)
  @RequirePermission("hr:interviews:manage")
  @Validate({ params: interviewIdParams })
  read(
    @Param("interviewId", ParseIntPipe) interviewId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transcripts.read(u.orgId, u.userId, interviewId);
  }

  @Post()
  @ResponseSchema(transcriptViewSchema)
  @RequirePermission("hr:interviews:manage")
  @Validate({ params: interviewIdParams, body: storeTranscriptSchema })
  store(
    @Param("interviewId", ParseIntPipe) interviewId: number,
    @Body() body: StoreTranscriptInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transcripts.store(
      u.orgId,
      u.userId,
      actingMembershipId(u.principal),
      interviewId,
      body,
    );
  }

  /**
   * Erasure takes a reason and a DELETE body, which is unusual but right: this
   * is the route a DPDP request is satisfied through, and "who asked and why"
   * belongs in the audit row next to "what was removed".
   */
  @Delete()
  @ResponseSchema(z.object({ erased: z.boolean() }))
  @RequirePermission("hr:interviews:manage")
  @Validate({ params: interviewIdParams, body: eraseTranscriptSchema })
  erase(
    @Param("interviewId", ParseIntPipe) interviewId: number,
    @Body() body: EraseTranscriptInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transcripts.erase(u.orgId, u.userId, interviewId, body.reason);
  }
}
