import { InternalServerErrorException, Logger } from "@nestjs/common";
import { TerminationCommunicationsService } from "./termination-communications.service";

describe("TerminationCommunicationsService", () => {
  it("does not persist or return provider error details", async () => {
    const providerError = "SMTP password rejected for secret-provider-account";
    const logError = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const updateWhere = jest.fn().mockResolvedValue(undefined);
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const db = {
      query: {
        terminations: {
          findFirst: jest.fn().mockResolvedValue({
            id: 7,
            orgId: "org-1",
            userId: "employee-1",
            status: "APPROVED",
            emailSentAt: null,
            emailStatus: null,
            effectiveDate: "2026-08-31",
            reasons: ["Role closed"],
            user: {
              id: "employee-1",
              name: "Employee",
              email: "employee@example.com",
              designation: "Engineer",
            },
          }),
        },
        users: {
          findFirst: jest.fn().mockResolvedValue({ name: "HR Manager" }),
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ supportEmail: "hr@example.com" }]),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: updateSet,
      }),
      execute: jest.fn().mockResolvedValue([{ relationAvailable: false }]),
    };
    const audit = { logCritical: jest.fn().mockResolvedValue(undefined) };
    const email = {
      sendEmail: jest.fn().mockRejectedValue(new Error(providerError)),
    };
    const service = new TerminationCommunicationsService(
      db as never,
      audit as never,
      email as never,
      { getFacts: jest.fn().mockResolvedValue({ userId: "u", employmentId: null, employeeNumber: null, designation: null, joiningDate: null, departmentId: null, locationId: null, managerUserId: null }), getFactsBatch: jest.fn().mockResolvedValue(new Map()) } as never,
    );

    const result = service.sendEmail("org-1", "actor-1", 7);

    await expect(result).rejects.toBeInstanceOf(InternalServerErrorException);
    await result.catch((error: InternalServerErrorException) => {
      expect(error.getResponse()).toEqual({
        code: "TERMINATION_EMAIL_DELIVERY_FAILED",
        message: "The termination email could not be sent. Try again later.",
      });
      expect(JSON.stringify(error.getResponse())).not.toContain(providerError);
    });
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ emailStatus: "failed" }),
    );
    expect(JSON.stringify(updateSet.mock.calls)).not.toContain(providerError);
    expect(audit.logCritical).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TERMINATION_EMAIL_FAILED",
        metadata: {
          employeeId: "employee-1",
          failureCode: "EMAIL_DELIVERY_FAILED",
        },
      }),
    );
    expect(logError).toHaveBeenCalledWith(
      "Termination email delivery failed",
      expect.stringContaining(providerError),
    );
    logError.mockRestore();
  });
});
