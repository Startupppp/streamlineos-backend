import { HttpException, HttpStatus } from "@nestjs/common";

export class ModuleDisabledException extends HttpException {
  constructor(module: string) {
    super(
      { error: "Module not available on this plan", code: "MODULE_DISABLED", module },
      HttpStatus.NOT_FOUND,
    );
  }
}

export class ProjectsForbiddenTicketException extends HttpException {
  constructor() {
    super(
      { code: "PROJECTS_FORBIDDEN_TICKET", message: "You don't have access to this ticket's details." },
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
      { code: "CHAT_ACTION_FORBIDDEN", message: "Not authorized to perform this chat action" },
      HttpStatus.FORBIDDEN,
    );
  }
}

export class ChatActionTicketStatusFailedException extends HttpException {
  constructor() {
    super(
      { code: "CHAT_ACTION_TICKET_STATUS_FAILED", message: "Ticket status transition is not valid" },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class ProjectsTicketConflictException extends HttpException {
  constructor() {
    super(
      { code: "PROJECTS_TICKET_CONFLICT", message: "Ticket was modified by another request. Please refresh and try again." },
      HttpStatus.CONFLICT,
    );
  }
}

export class ProjectsInvalidTicketStatusException extends HttpException {
  constructor(status: string) {
    super(
      { code: "PROJECTS_INVALID_TICKET_STATUS", message: `"${status}" is not a valid status for this project` },
      HttpStatus.BAD_REQUEST,
    );
  }
}

export class SupportTicketStaleException extends HttpException {
  constructor() {
    super(
      { code: "STALE_TICKET", message: "Ticket was modified by another request. Please refresh and try again." },
      HttpStatus.CONFLICT,
    );
  }
}
