import { BadRequestException } from "@nestjs/common";
import type { IntegrationToolkit } from "../../../db/schema";

export type ConnectionReturnPath = "/calendar" | "/mail";

export function toIntegrationToolkit(slug: string | null): IntegrationToolkit {
  if (slug === "googlecalendar" || slug === "outlook" || slug === "gmail") return slug;
  throw new BadRequestException(`Unsupported toolkit: ${slug ?? "unknown"}`);
}

export function defaultReturnPath(toolkit: IntegrationToolkit): ConnectionReturnPath {
  return toolkit === "gmail" ? "/mail" : "/calendar";
}
