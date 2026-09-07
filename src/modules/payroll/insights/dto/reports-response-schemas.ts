import type { SchemaObject } from "@nestjs/swagger/dist/interfaces/open-api-spec.interface";

export const journalResultSchema: SchemaObject = {
  type: "object",
  properties: {
    provisional: { type: "boolean" },
    month: { type: "string" },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          account: { type: "string" },
          description: { type: "string" },
          debit: { type: "number" },
          credit: { type: "number" },
          costCenter: { type: "string", nullable: true },
        },
        required: ["account", "description", "debit", "credit", "costCenter"],
      },
    },
    unmappedCodes: { type: "array", items: { type: "string" } },
    totalDebits: { type: "number" },
    totalCredits: { type: "number" },
  },
  required: ["provisional", "month", "lines", "unmappedCodes", "totalDebits", "totalCredits"],
};

const paginationSchemaObj: SchemaObject = {
  type: "object",
  properties: {
    limit: { type: "number" },
    hasMore: { type: "boolean" },
    nextCursor: { type: "string", nullable: true },
  },
  required: ["limit", "hasMore", "nextCursor"],
};

const employeeRegisterRowObj: SchemaObject = {
  type: "object",
  properties: {
    employeeId: { type: "string" },
    name: { type: "string", nullable: true },
    department: { type: "string", nullable: true },
    workerType: { type: "string" },
    paidDays: { type: "string" },
    gross: { type: "string" },
    totalDeductions: { type: "string" },
    net: { type: "string" },
    components: { type: "object", additionalProperties: { type: "string" } },
  },
  required: ["employeeId", "name", "department", "workerType", "paidDays", "gross", "totalDeductions", "net", "components"],
};

export const summaryReportSchema: SchemaObject = {
  type: "object",
  properties: {
    provisional: { type: "boolean" },
    run: {
      nullable: true,
      type: "object",
      properties: {
        month: { type: "string" },
        status: { type: "string" },
        employeeCount: { type: "number", nullable: true },
        grossTotal: { type: "string" },
        deductionTotal: { type: "string" },
        netTotal: { type: "string" },
        employerCostTotal: { type: "string" },
        exceptionCount: { type: "number", nullable: true },
      },
    },
  },
  required: ["provisional", "run"],
};

export const employeeRegisterReportSchema: SchemaObject = {
  type: "object",
  properties: {
    provisional: { type: "boolean" },
    columns: { type: "array", items: { type: "string" } },
    rows: { type: "array", items: employeeRegisterRowObj },
    pagination: paginationSchemaObj,
  },
  required: ["provisional", "columns", "rows", "pagination"],
};

export const departmentCostReportSchema: SchemaObject = {
  type: "object",
  properties: {
    provisional: { type: "boolean" },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          department: { type: "string", nullable: true },
          employeeCount: { type: "number" },
          grossTotal: { type: "string" },
          netTotal: { type: "string" },
          employerCostTotal: { type: "string" },
        },
        required: ["department", "employeeCount", "grossTotal", "netTotal", "employerCostTotal"],
      },
    },
    pagination: paginationSchemaObj,
  },
  required: ["provisional", "rows", "pagination"],
};

export const costCenterReportSchema: SchemaObject = {
  type: "object",
  properties: {
    provisional: { type: "boolean" },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          costCenter: { type: "string", nullable: true },
          employeeCount: { type: "number" },
          grossTotal: { type: "string" },
          netTotal: { type: "string" },
        },
        required: ["costCenter", "employeeCount", "grossTotal", "netTotal"],
      },
    },
    pagination: paginationSchemaObj,
  },
  required: ["provisional", "rows", "pagination"],
};

export const bankPayoutReportSchema: SchemaObject = {
  type: "object",
  properties: {
    provisional: { type: "boolean" },
    batches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          batchNumber: { type: "string" },
          format: { type: "string" },
          totalAmount: { type: "string" },
          itemCount: { type: "number" },
          status: { type: "string" },
          generatedAt: { type: "string", format: "date-time" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                userName: { type: "string", nullable: true },
                accountMasked: { type: "string" },
                ifsc: { type: "string", nullable: true },
                amount: { type: "string" },
                status: { type: "string" },
              },
              required: ["userName", "accountMasked", "ifsc", "amount", "status"],
            },
          },
        },
        required: ["batchNumber", "format", "totalAmount", "itemCount", "status", "generatedAt", "items"],
      },
    },
    pagination: paginationSchemaObj,
  },
  required: ["provisional", "batches", "pagination"],
};

const runSummaryObj: SchemaObject = {
  type: "object",
  properties: {
    month: { type: "string" },
    gross: { type: "string" },
    net: { type: "string" },
  },
  required: ["month", "gross", "net"],
};

export const varianceReportSchema: SchemaObject = {
  type: "object",
  properties: {
    provisional: { type: "boolean" },
    current: runSummaryObj,
    previous: runSummaryObj,
    delta: {
      type: "object",
      properties: { gross: { type: "string" }, net: { type: "string" } },
      required: ["gross", "net"],
    },
    perEmployee: {
      type: "array",
      items: {
        type: "object",
        properties: {
          userId: { type: "string" },
          name: { type: "string", nullable: true },
          prevGross: { type: "string" },
          currGross: { type: "string" },
          grossDelta: { type: "string" },
          prevNet: { type: "string" },
          currNet: { type: "string" },
          netDelta: { type: "string" },
        },
        required: ["userId", "name", "prevGross", "currGross", "grossDelta", "prevNet", "currNet", "netDelta"],
      },
    },
    pagination: paginationSchemaObj,
  },
  required: ["provisional", "current", "previous", "delta", "perEmployee", "pagination"],
};
