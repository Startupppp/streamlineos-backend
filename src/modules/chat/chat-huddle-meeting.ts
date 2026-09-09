import { PreconditionFailedException, ServiceUnavailableException } from "@nestjs/common";
import { z } from "zod";
import type { Db } from "../../db/drizzle.types";
import {
  ComposioToolError,
  type ComposioGateway,
} from "../integrations/core/composio.gateway";
import { resolveToolkitConnection } from "../integrations/core/connection-resolution";
import { TOOL_SLUGS, unwrapComposioData } from "../calendar/external-event-normalizers";

const MEETING_TOOLKIT = "googlecalendar" as const;

const googleMeetEventSchema = z
  .object({ id: z.string().optional(), hangoutLink: z.string().url().optional() })
  .passthrough();

export const HUDDLE_MEETING_UNCONFIGURED =
  "Huddles need a Google Workspace connection, and this deployment has no Composio integration configured. Ask your platform administrator to configure it.";

export const HUDDLE_MEETING_NO_CONNECTION =
  "Huddles need a connected Google account and this organization has none. An organization owner or admin can connect one under Settings → Integrations.";

export const HUDDLE_MEETING_NEEDS_REAUTH =
  "The Google account this organization uses for huddles needs to be reconnected. An organization owner or admin can reconnect it under Settings → Integrations.";

export const HUDDLE_MEETING_PROVIDER_FAILED =
  "Google could not create a meeting for this huddle. Nothing was started — please try again.";

export const HUDDLE_MEETING_NO_LINK =
  "Google created the meeting but returned no join link, so the huddle would have had no way in. Nothing was started — please try again.";

export interface HuddleMeetingSubject {
  channelName: string;
  startsAt: Date;
  estimatedEndsAt: Date;
}

export interface HuddleMeetingConnection {
  composioUserId: string;
  composioConnectedAccountId: string;
}

/**
 * Resolved inside the caller's tenant transaction; the Composio call that consumes it runs
 * outside one, which is why the two halves are separate exports.
 */
export async function resolveHuddleMeetingConnection(
  db: Db,
  orgId: string,
  userId: string,
  membershipId: number,
): Promise<HuddleMeetingConnection> {
  const resolution = await resolveToolkitConnection(db, {
    orgId,
    userId,
    membershipId,
    toolkit: MEETING_TOOLKIT,
  });
  if (resolution.status === "unresolved")
    throw new PreconditionFailedException(
      resolution.reason === "needs-reauth"
        ? HUDDLE_MEETING_NEEDS_REAUTH
        : HUDDLE_MEETING_NO_CONNECTION,
    );
  return {
    composioUserId: resolution.connection.composioUserId,
    composioConnectedAccountId: resolution.connection.composioConnectedAccountId,
  };
}

export async function mintHuddleMeetingUrl(
  gateway: ComposioGateway,
  connection: HuddleMeetingConnection,
  subject: HuddleMeetingSubject,
): Promise<string> {
  if (!gateway.isConfigured()) throw new ServiceUnavailableException(HUDDLE_MEETING_UNCONFIGURED);

  let raw: unknown;
  try {
    raw = await gateway.executeTool(
      TOOL_SLUGS.googleCreate,
      connection.composioUserId,
      {
        summary: `Huddle in #${subject.channelName}`,
        start_datetime: subject.startsAt.toISOString(),
        end_datetime: subject.estimatedEndsAt.toISOString(),
        create_meeting_room: true,
      },
      connection.composioConnectedAccountId,
    );
  } catch (error) {
    if (error instanceof ComposioToolError && error.isAuthError)
      throw new PreconditionFailedException(HUDDLE_MEETING_NEEDS_REAUTH);
    throw new ServiceUnavailableException(HUDDLE_MEETING_PROVIDER_FAILED);
  }

  const parsed = googleMeetEventSchema.safeParse(unwrapComposioData(raw));
  const link = parsed.success ? parsed.data.hangoutLink : undefined;
  if (!link) throw new ServiceUnavailableException(HUDDLE_MEETING_NO_LINK);
  return link;
}
