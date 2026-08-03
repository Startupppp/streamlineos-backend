export interface Permission {
  name: string;
  resource: string;
  action: string;
  description: string;
  scopable?: boolean;
}
