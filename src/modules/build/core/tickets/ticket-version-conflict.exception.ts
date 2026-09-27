import { HttpException, HttpStatus } from "@nestjs/common";

export class TicketVersionConflictException extends HttpException {
  constructor(currentVersion: number) {
    super(
      {
        code: "PROJECTS_TICKET_CONFLICT",
        message:
          "Ticket was modified by another request. Please refresh and try again.",
        details: { currentVersion },
      },
      HttpStatus.CONFLICT,
    );
  }
}
