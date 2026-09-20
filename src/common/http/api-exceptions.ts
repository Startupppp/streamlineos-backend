import { HttpException, HttpStatus } from "@nestjs/common";
import type { ModuleAvailabilityReason } from "../rbac/module-availability";
import { moduleDefinition } from "../rbac/module-registry";

export class PaymentRequiredException extends HttpException {
  constructor(body: Record<string, unknown>) {
    super(body, HttpStatus.PAYMENT_REQUIRED);
  }
}

export class InsufficientAiCreditsException extends HttpException {
  constructor(options?: {
    message?: string;
    details?: Record<string, unknown>;
  }) {
    super(
      {
        code: "INSUFFICIENT_CREDITS",
        message: options?.message?.trim()
          ? options.message
          : "Insufficient AI credits",
        ...(options?.details !== undefined ? { details: options.details } : {}),
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

const MODULE_DENIAL_MESSAGE: Record<
  ModuleAvailabilityReason,
  (moduleName: string) => string
> = {
  "not-in-plan": (moduleName) => `${moduleName} is not included in your current plan.`,
  "org-disabled": (moduleName) => `${moduleName} is not enabled for your organization.`,
  "user-denied": (moduleName) => `You do not have access to ${moduleName}.`,
};

function moduleDisplayName(moduleKey: string): string {
  return moduleDefinition(moduleKey)?.displayName ?? moduleKey;
}

export class ModuleDisabledException extends HttpException {
  constructor(moduleKey: string, reason: ModuleAvailabilityReason) {
    super(
      {
        code: "MODULE_NOT_ENABLED",
        message: MODULE_DENIAL_MESSAGE[reason](moduleDisplayName(moduleKey)),
        details: {
          moduleKey,
          reason,
          upgradePath: reason === "not-in-plan" ? "/settings/billing" : null,
        },
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

export class ProjectsForbiddenTicketException extends HttpException {
  constructor() {
    super(
      {
        code: "PROJECTS_FORBIDDEN_TICKET",
        message: "You don't have access to this ticket's details.",
      },
      HttpStatus.FORBIDDEN,
    );
  }
}

export class ProjectsForbiddenProjectException extends HttpException {
  constructor(projectId: number) {
    super(
      {
        code: "PROJECTS_FORBIDDEN_PROJECT",
        message: "You are not a member of this project.",
        details: { reason: "NOT_A_MEMBER", projectId },
      },
      HttpStatus.FORBIDDEN,
    );
  }
}

export class ProjectsNotFoundException extends HttpException {
  constructor() {
    super(
      { code: "PROJECTS_NOT_FOUND", message: "Project not found" },
      HttpStatus.NOT_FOUND,
    );
  }
}

export class ProjectsTicketNotFoundException extends HttpException {
  constructor() {
    super(
      { code: "PROJECTS_TICKET_NOT_FOUND", message: "Ticket not found" },
      HttpStatus.NOT_FOUND,
    );
  }
}

export class ProjectsCommentNotFoundException extends HttpException {
  constructor() {
    super(
      { code: "PROJECTS_COMMENT_NOT_FOUND", message: "Comment not found" },
      HttpStatus.NOT_FOUND,
    );
  }
}

export class ChatActionForbiddenException extends HttpException {
  constructor() {
    super(
      {
        code: "CHAT_ACTION_FORBIDDEN",
        message: "Not authorized to perform this chat action",
      },
      HttpStatus.FORBIDDEN,
    );
  }
}

export class ChatActionTicketStatusFailedException extends HttpException {
  constructor() {
    super(
      {
        code: "CHAT_ACTION_TICKET_STATUS_FAILED",
        message: "Ticket status transition is not valid",
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class ProjectsTicketConflictException extends HttpException {
  constructor() {
    super(
      {
        code: "PROJECTS_TICKET_CONFLICT",
        message:
          "Ticket was modified by another request. Please refresh and try again.",
      },
      HttpStatus.CONFLICT,
    );
  }
}

export class ProjectsInvalidTicketStatusException extends HttpException {
  constructor(status: string) {
    super(
      {
        code: "PROJECTS_INVALID_TICKET_STATUS",
        message: `"${status}" is not a valid status for this project`,
      },
      HttpStatus.BAD_REQUEST,
    );
  }
}

export class SupportTicketStaleException extends HttpException {
  constructor() {
    super(
      {
        code: "STALE_TICKET",
        message:
          "Ticket was modified by another request. Please refresh and try again.",
      },
      HttpStatus.CONFLICT,
    );
  }
}
