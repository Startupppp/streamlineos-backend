import { timingSafeEqual } from "node:crypto";
import { signCursor } from "./mail-cursor-signing";

/**
 * A second cursor namespace, for pages served from `mail_message_metadata`
 * rather than from a provider.
 *
 * The two regimes cannot share an encoding. A provider cursor carries one
 * position per account and resuming means asking Gmail or Graph for the next
 * page; a metadata cursor carries a `(date, id)` keyset and resuming means a
 * row comparison against the local index. Reading one as the other would
 * silently restart the list, so `MD_CURSOR_VERSION` differs from
 * `CURSOR_VERSION` in `mail-normalizers.ts` and each decoder rejects the other's prefix outright — which
 * is also what lets `listMessages` decide the regime once, at page one, and
 * keep it for the whole scroll instead of switching halfway and repeating rows.
 *
 * `d` is the row's `date` as an ISO string, or `null` for a row with no date at
 * all. Those sort first under `ORDER BY date DESC` (Postgres defaults DESC to
 * NULLS FIRST), so the null branch is a real page-one position, not an error.
 */
export interface MailMetadataCursor {
  readonly d: string | null;
  readonly i: number;
}

const MD_CURSOR_VERSION = "md1";

interface SignedMetadataCursorBody {
  readonly u: string;
  readonly k: MailMetadataCursor;
}

export function encodeMetadataCursor(keyset: MailMetadataCursor, userId: string): string {
  const body: SignedMetadataCursorBody = { u: userId, k: keyset };
  const encoded = Buffer.from(JSON.stringify(body), "utf-8").toString("base64url");
  return `${MD_CURSOR_VERSION}.${encoded}.${signCursor(encoded)}`;
}

export function decodeMetadataCursor(encoded: string, userId: string): MailMetadataCursor | null {
  const parts = encoded.split(".");
  if (parts.length !== 3) return null;

  const [version, body, signature] = parts;
  if (version !== MD_CURSOR_VERSION || !body || !signature) return null;

  const expected = Buffer.from(signCursor(body), "utf-8");
  const actual = Buffer.from(signature, "utf-8");
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

    const { u, k } = parsed as Record<string, unknown>;
    if (typeof u !== "string" || u !== userId) return null;
    if (typeof k !== "object" || k === null || Array.isArray(k)) return null;

    const { d, i } = k as Record<string, unknown>;
    if (d !== null && typeof d !== "string") return null;
    if (typeof i !== "number" || !Number.isFinite(i)) return null;

    return { d, i };
  } catch {
    return null;
  }
}
