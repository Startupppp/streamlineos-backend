import { SetMetadata } from "@nestjs/common";

export const ASK_OS_TOOLS_KEY = "ask_os_tools";

export const AskOsTools = (): ClassDecorator => SetMetadata(ASK_OS_TOOLS_KEY, true);
