import {
  resolveProvider,
  type ProviderBlocked,
  type ProviderCredentials,
} from "../../recruitment/integrations/provider-blocked";

export const TRANSCRIPTION_PLATFORM = "TRANSCRIPTION";

export interface TranscriptionRequest {
  /** Where the recording can be fetched from. */
  recordingUrl: string;
  /** BCP-47, best effort; a vendor that cannot honour it should ignore it. */
  languageHint?: string;
}

export interface TranscriptionResult {
  text: string;
  /** What the vendor called itself, for `transcript_source` provenance. */
  provider: string;
}

export interface TranscriptionAdapter {
  transcribe(
    credentials: ProviderCredentials,
    request: TranscriptionRequest,
  ): Promise<TranscriptionResult>;
}

/**
 * Empty, and this is the one place it most matters.
 *
 * A transcript is what a hiring decision gets justified with months later. An
 * adapter that returned a plausible-looking summary without a vendor behind it
 * would put invented sentences in a person's hiring record and there would be
 * no way to tell them from a real transcription. The manual upload path stores
 * and reads exactly the same field, so nothing is lost except the automation.
 */
export const TRANSCRIPTION_ADAPTERS: ReadonlyMap<string, TranscriptionAdapter> = new Map();

export function resolveTranscription(
  credentials: ProviderCredentials | null,
): { adapter: TranscriptionAdapter; credentials: ProviderCredentials } | ProviderBlocked {
  return resolveProvider(
    TRANSCRIPTION_PLATFORM,
    credentials,
    TRANSCRIPTION_ADAPTERS,
    "Interview transcription",
    "Upload a transcript yourself; it is stored and read the same way.",
  );
}

/**
 * How long a transcript is kept when nobody names a period.
 *
 * Twelve months: long enough to answer a discrimination claim or an internal
 * review, short enough that a recording of a conversation is not held forever
 * by default. A caller may set a shorter one; the sweep enforces whichever was
 * stamped.
 */
export const DEFAULT_RETENTION_DAYS = 365;
export const MAX_RETENTION_DAYS = 365 * 3;
