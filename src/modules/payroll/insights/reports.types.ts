export interface EmployeeRegisterRow {
  employeeId: string;
  name: string | null;
  department: string | null;
  workerType: string;
  paidDays: string;
  gross: string;
  totalDeductions: string;
  net: string;
  components: Record<string, string>;
}

export interface DeptCostRow {
  department: string | null;
  employeeCount: number;
  grossTotal: string;
  netTotal: string;
  employerCostTotal: string;
}

export interface CostCenterRow {
  costCenter: string | null;
  employeeCount: number;
  grossTotal: string;
  netTotal: string;
}

export interface BankItem {
  userName: string | null;
  accountMasked: string;
  ifsc: string | null;
  amount: string;
  status: string;
}

export interface BankBatchResult {
  batchNumber: string;
  format: string;
  totalAmount: string;
  itemCount: number;
  status: string;
  generatedAt: Date;
  items: BankItem[];
}

export interface VarianceEmployeeRow {
  userId: string;
  name: string | null;
  prevGross: string;
  currGross: string;
  grossDelta: string;
  prevNet: string;
  currNet: string;
  netDelta: string;
}

export interface PaginationParams {
  limit?: number;
  cursor?: string;
}
