import { SetMetadata } from "@nestjs/common";
import type { WorkClass } from "./work-class";

export const WORK_CLASS_KEY = "admission:work_class";

export const UseWorkClass = (workClass: WorkClass) => SetMetadata(WORK_CLASS_KEY, workClass);
