import { SetMetadata } from "@nestjs/common";

export const DEPRECATION_KEY = "deprecation";

export interface DeprecationMeta {
  sunset?: string;
  link?: string;
}

export const Deprecated = (opts?: DeprecationMeta): MethodDecorator & ClassDecorator =>
  SetMetadata(DEPRECATION_KEY, opts ?? {});
