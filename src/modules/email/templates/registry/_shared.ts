import { appUrl } from "../../app-url";
import { getBrandName } from "../../branding";

export const BASE_URL = appUrl;
export const BRAND = getBrandName();

export interface TemplateEntry {
  category: string;
  name: string;
  subject: string;
  generateHtml: () => string;
}
