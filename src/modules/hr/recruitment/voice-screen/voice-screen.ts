import {
  resolveProvider,
  type ProviderBlocked,
  type ProviderCredentials,
} from "../integrations/provider-blocked";

export const VOICE_SCREEN_PLATFORM = "VOICE_SCREEN";

export interface VoiceScreenRequest {
  candidateName: string;
  candidatePhone: string;
  /** The questions the screen must ask, in order. */
  script: readonly string[];
  externalCaseKey: string;
}

export interface VoiceScreenAccepted {
  /** The vendor's call id; every later result must carry it. */
  reference: string;
}

export interface VoiceScreenAdapter {
  place(
    credentials: ProviderCredentials,
    request: VoiceScreenRequest,
  ): Promise<VoiceScreenAccepted>;
}

/**
 * Empty, and this one places phone calls.
 *
 * Everywhere else an absent adapter costs an automation. Here a stub would ring
 * a candidate's phone, or — worse, because it is the failure that would not be
 * noticed — record a screen as completed and scored with nobody having spoken
 * to anybody. A recruiter reading "voice screen: 4/5" has no way to tell that
 * from a real one.
 */
export const VOICE_SCREEN_ADAPTERS: ReadonlyMap<string, VoiceScreenAdapter> = new Map();

export function resolveVoiceScreen(
  credentials: ProviderCredentials | null,
): { adapter: VoiceScreenAdapter; credentials: ProviderCredentials } | ProviderBlocked {
  return resolveProvider(
    VOICE_SCREEN_PLATFORM,
    credentials,
    VOICE_SCREEN_ADAPTERS,
    "Voice screening",
    "Run the screen yourself and record it as a phone interview with a scorecard.",
  );
}

/** How a result may arrive, which is the only thing a completion may claim. */
export const COMPLETION_SOURCES = ["PROVIDER", "RECRUITER"] as const;
export type CompletionSource = (typeof COMPLETION_SOURCES)[number];

export interface ScreenAnswer {
  question: string;
  answer: string;
  /** The vendor's own confidence, 0-1, when it reports one. */
  confidence: number | null;
}

export interface VoiceScreenResult {
  reference: string;
  answers: readonly ScreenAnswer[];
  /** 1-5, the same scale the rest of recruitment rates on. */
  rating: number | null;
}

/**
 * Validates a vendor result without a schema library.
 *
 * Returns null rather than throwing, so a malformed payload becomes a 400 the
 * caller writes rather than a ZodError escaping a transaction on a public
 * route.
 *
 * The answer count is capped because this arrives from outside: an unbounded
 * array of unbounded strings on a public endpoint is a storage attack with a
 * signature on it.
 */
export function parseVoiceScreenResult(value: unknown): VoiceScreenResult | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  const reference = record.reference;
  if (typeof reference !== "string" || reference.length === 0 || reference.length > 200) {
    return null;
  }

  const rawAnswers = record.answers;
  if (!Array.isArray(rawAnswers) || rawAnswers.length > 30) return null;

  const answers: ScreenAnswer[] = [];
  for (const entry of rawAnswers) {
    if (typeof entry !== "object" || entry === null) return null;
    const { question, answer, confidence } = entry as Record<string, unknown>;
    if (typeof question !== "string" || question.length === 0 || question.length > 500) return null;
    if (typeof answer !== "string" || answer.length > 5000) return null;
    if (confidence !== undefined && confidence !== null) {
      if (typeof confidence !== "number" || confidence < 0 || confidence > 1) return null;
    }
    answers.push({
      question,
      answer,
      confidence: typeof confidence === "number" ? confidence : null,
    });
  }

  const rating = record.rating;
  if (rating !== undefined && rating !== null) {
    if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      return null;
    }
  }

  return {
    reference,
    answers,
    rating: typeof rating === "number" ? rating : null,
  };
}

/**
 * Whether a screen may be marked complete.
 *
 * The acceptance criterion in one function: a completion may only be claimed
 * from a provider result or from a recruiter who ran the screen themselves, and
 * the row says which. Nothing may mark a screen "completed by AI" on the
 * strength of having sent a request.
 */
export function canComplete(source: CompletionSource, hasResult: boolean): boolean {
  if (source === "RECRUITER") return true;
  return hasResult;
}
