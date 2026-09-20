import { z } from "zod";
import { DEFAULT_QUEUE_DEPTH_FACTOR } from "../../db/pool-admission";
import { resolvePoolMax, resolveTransactionGuards } from "../../db/pool.config";

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalInt = (min: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).optional());

const optionalPositiveFloat = () =>
  z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(1).optional());

const optionalBool = () =>
  z.preprocess(
    (v) => {
      if (v === undefined || v === "") return undefined;
      if (v === "true" || v === "1") return true;
      if (v === "false" || v === "0") return false;
      return v;
    },
    z.boolean().optional(),
  );

export const admissionEnvShape = {
  ADMISSION_MAX_CONCURRENT: optionalInt(1),
  ADMISSION_MAX_QUEUE_DEPTH: optionalInt(0),
  ADMISSION_MAX_EXECUTION_MS: optionalInt(1),
  ADMISSION_MAX_BODY_BYTES: optionalInt(1),
  ADMISSION_ORG_MAX_CONCURRENT: optionalInt(1),
  ADMISSION_RESERVED_FRACTION: optionalPositiveFloat(),
  ADMISSION_ENABLED: optionalBool(),
} as const;

const admissionEnvSchema = z.object(admissionEnvShape);

export interface AdmissionConfig {
  maxConcurrent: number;
  maxQueueDepth: number;
  maxExecutionMs: number;
  maxBodyBytes: number;
  orgMaxConcurrent: number;
  reservedFraction: number;
  enabled: boolean;
}

function parseAdmissionEnv(env: NodeJS.ProcessEnv): z.infer<typeof admissionEnvSchema> {
  const result = admissionEnvSchema.safeParse(env);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`[admission] Invalid admission configuration:\n${issues}`);
}

export function resolveAdmissionConfig(env: NodeJS.ProcessEnv = process.env): AdmissionConfig {
  const parsed = parseAdmissionEnv(env);
  const servable = resolvePoolMax(env) * (1 + DEFAULT_QUEUE_DEPTH_FACTOR);
  const maxConcurrent = parsed.ADMISSION_MAX_CONCURRENT ?? servable;

  return {
    maxConcurrent,
    maxQueueDepth: parsed.ADMISSION_MAX_QUEUE_DEPTH ?? maxConcurrent * 2,
    maxExecutionMs:
      parsed.ADMISSION_MAX_EXECUTION_MS ?? resolveTransactionGuards(env).statementTimeoutMs,
    maxBodyBytes: parsed.ADMISSION_MAX_BODY_BYTES ?? 3_145_728,
    orgMaxConcurrent:
      parsed.ADMISSION_ORG_MAX_CONCURRENT ?? Math.max(1, Math.floor(maxConcurrent / 2)),
    reservedFraction: parsed.ADMISSION_RESERVED_FRACTION ?? 0.2,
    enabled: parsed.ADMISSION_ENABLED ?? true,
  };
}
