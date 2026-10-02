import { BadRequestException } from "@nestjs/common";
import { decodeTupleCursor } from "../../../common/pagination/cursor";

export const NULL_DETECTED_AT = "__NULL_DETECTED_AT__";
export const INCIDENT_PAGE_SIZE = 100;

export function decodeIncidentCursor(cursor: string | undefined) {
  if (!cursor) return undefined;
  const parts = decodeTupleCursor(cursor, 2);
  if (!parts) throw new BadRequestException("Invalid pagination cursor");
  const [detectedAtValue, idValue] = parts;
  const id = Number(idValue);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) {
    throw new BadRequestException("Invalid pagination cursor");
  }
  if (detectedAtValue === NULL_DETECTED_AT) return { id, detectedAt: null };
  const detectedAt = new Date(detectedAtValue);
  if (Number.isNaN(detectedAt.getTime()) || detectedAt.toISOString() !== detectedAtValue) {
    throw new BadRequestException("Invalid pagination cursor");
  }
  return { id, detectedAt };
}
