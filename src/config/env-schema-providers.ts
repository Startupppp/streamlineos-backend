import { z } from "zod";
import { emptyToUndefined, optionalUrl } from "./env-schema-helpers";
import { KNOWN_CHAT_MODEL_IDS, isKnownChatModelId } from "../modules/ai/core/billing/ai-model-pricing.constants";

export const providerEnvShape = {
    OPENAI_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    OPENROUTER_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    GOOGLE_GENERATIVE_AI_API_KEY: z.preprocess(
      emptyToUndefined,
      z.string().optional(),
    ),
    AI_LLM_PROVIDER: z.preprocess(
      emptyToUndefined,
      z.enum(["openai", "openrouter"]).optional(),
    ),
    AI_CHAT_PROVIDER: z.preprocess(
      emptyToUndefined,
      z.enum(["google", "openrouter"]).optional(),
    ),
    AI_CHAT_MODEL: z.preprocess(
      emptyToUndefined,
      z.string().refine(
        (v) => isKnownChatModelId(v),
        { message: `AI_CHAT_MODEL must be one of: ${[...KNOWN_CHAT_MODEL_IDS].join(", ")}` },
      ).optional(),
    ),
    AI_FAST_FALLBACK_MODELS: z.preprocess(
      emptyToUndefined,
      z.string().trim().optional(),
    ),
    AI_STANDARD_FALLBACK_MODELS: z.preprocess(
      emptyToUndefined,
      z.string().trim().optional(),
    ),
    /** Left unbounded above; the retry policy clamps to 5 rather than failing a boot over it. */
    AI_LLM_MAX_RETRIES: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(0).optional(),
    ),
    RAZORPAY_KEY_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    RAZORPAY_KEY_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
    RAZORPAY_WEBHOOK_SECRET: z.preprocess(
      emptyToUndefined,
      z.string().optional(),
    ),
    /**
     * Stripe, which serves everywhere Razorpay does not.
     *
     * Optional like Razorpay's: a deployment that only sells in India needs no
     * Stripe account, and requiring one would make the whole application refuse
     * to boot for want of a provider it never calls.
     */
    STRIPE_SECRET_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    STRIPE_PUBLISHABLE_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    STRIPE_WEBHOOK_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
    VAPID_PUBLIC_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    VAPID_PRIVATE_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    R2_REGION: z.preprocess(emptyToUndefined, z.string().optional()),
    R2_BUCKET_NAME: z.preprocess(emptyToUndefined, z.string().optional()),
    R2_ACCESS_KEY_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    R2_SECRET_ACCESS_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    R2_KB_BUCKET_NAME: z.preprocess(emptyToUndefined, z.string().optional()),
    R2_ENDPOINT: optionalUrl,
    NEXT_PUBLIC_R2_PUBLIC_URL: optionalUrl,
    R2_KB_PUBLIC_URL: optionalUrl,
    TWILIO_ACCOUNT_SID: z.preprocess(emptyToUndefined, z.string().optional()),
    TWILIO_AUTH_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
    TWILIO_FROM_NUMBER: z.preprocess(emptyToUndefined, z.string().optional()),
    /**
     * SMS one-time codes for e-signature. `EnvSmsSender` reads both at
     * construction and offers the `otp_sms` authentication method only when
     * both are present, so a typo in either one silently removes a signing
     * method a tenant configured — which is exactly the failure the schema
     * exists to turn into a boot error. Optional because no provider ships
     * bound; the URL is validated as a URL so a half-pasted value fails at
     * boot rather than at the moment a signer is waiting for a code.
     */
    SIGN_SMS_PROVIDER_URL: optionalUrl,
    SIGN_SMS_PROVIDER_TOKEN: z.preprocess(
      emptyToUndefined,
      z.string().trim().optional(),
    ),
};
