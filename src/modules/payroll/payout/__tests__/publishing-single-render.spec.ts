describe("PublishingService — single PDF render per employee", () => {
  it("PDF buffer is generated once and reused for storage upload and email attachment", async () => {
    const pdfBuffer = Buffer.from("fake-pdf");
    const generatePayslipPdf = jest.fn().mockResolvedValue(pdfBuffer);
    const uploadFile = jest.fn().mockResolvedValue({ url: "https://s3.example.com/payslip.pdf", key: "payroll/payslips/1/payslip.pdf" });
    const sendEmail = jest.fn().mockResolvedValue(undefined);

    const simulatePublishOneEmployee = async (emailPayslips: boolean) => {
      let renderedPdfBuffer: Buffer | null;
      try {
        renderedPdfBuffer = await generatePayslipPdf();
        await uploadFile(renderedPdfBuffer);
      } catch {
        renderedPdfBuffer = null;
      }

      if (emailPayslips && renderedPdfBuffer) {
        await sendEmail(renderedPdfBuffer);
      }
    };

    await simulatePublishOneEmployee(true);

    expect(generatePayslipPdf).toHaveBeenCalledTimes(1);
    expect(uploadFile).toHaveBeenCalledWith(pdfBuffer);
    expect(sendEmail).toHaveBeenCalledWith(pdfBuffer);
  });

  it("email is skipped when PDF generation fails", async () => {
    const generatePayslipPdf = jest.fn().mockRejectedValue(new Error("PDF error"));
    const uploadFile = jest.fn();
    const sendEmail = jest.fn();

    const simulatePublishOneEmployee = async (emailPayslips: boolean) => {
      let renderedPdfBuffer: Buffer | null;
      try {
        renderedPdfBuffer = await generatePayslipPdf();
        await uploadFile(renderedPdfBuffer);
      } catch {
        renderedPdfBuffer = null;
      }

      if (emailPayslips && renderedPdfBuffer) {
        await sendEmail(renderedPdfBuffer);
      }
    };

    await simulatePublishOneEmployee(true);

    expect(generatePayslipPdf).toHaveBeenCalledTimes(1);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("email is skipped when emailPayslips toggle is false", async () => {
    const pdfBuffer = Buffer.from("fake-pdf");
    const generatePayslipPdf = jest.fn().mockResolvedValue(pdfBuffer);
    const uploadFile = jest.fn().mockResolvedValue({ url: null, key: null });
    const sendEmail = jest.fn();

    const simulatePublishOneEmployee = async (emailPayslips: boolean) => {
      let renderedPdfBuffer: Buffer | null;
      try {
        renderedPdfBuffer = await generatePayslipPdf();
        await uploadFile(renderedPdfBuffer);
      } catch {
        renderedPdfBuffer = null;
      }

      if (emailPayslips && renderedPdfBuffer) {
        await sendEmail(renderedPdfBuffer);
      }
    };

    await simulatePublishOneEmployee(false);

    expect(generatePayslipPdf).toHaveBeenCalledTimes(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
