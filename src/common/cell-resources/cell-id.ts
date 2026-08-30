import { LEGACY_CELL_ID } from "../region/placement";

export const PROCESS_CELL_ID: string = process.env.CELL_ID ?? LEGACY_CELL_ID;
