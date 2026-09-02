import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import type {
  AiInvokeFailure,
  AiInvokeResult,
} from "../gateway/ai-gateway.types";

function assertNever(x: never): never {
  throw new Error(`Unhandled AI failure kind: ${String(x)}`);
}

export function throwOnAiFailure(result: AiInvokeFailure): never {
  switch (result.kind) {
    case "quota_exceeded":
      throw new InsufficientAiCreditsException({ message: result.message });
    case "not_configured":
    case "provider_unavailable":
      throw new ServiceUnavailableException(result.message);
    case "invalid_output":
      throw new ServiceUnavailableException("AI returned an invalid response");
    case "context_too_large":
      throw new BadRequestException(result.message);
    case "concurrency_exceeded":
      throw new ServiceUnavailableException(result.message);
    default:
      assertNever(result.kind);
  }
}

export function unwrapAiResult<T>(result: AiInvokeResult<T>): T {
  if (result.ok) return result.data;
  return throwOnAiFailure(result);
}
