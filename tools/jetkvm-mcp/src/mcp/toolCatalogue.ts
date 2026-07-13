import type { z } from "zod";

import { JETKVM_TOOL_NAMES, type JetKvmToolName } from "../domain.js";
import { TOOL_INPUT_SCHEMAS, TOOL_RESULT_SCHEMAS } from "./schemas.js";

const TOOL_PRESENTATION: Record<
  JetKvmToolName,
  { readonly title: string; readonly description: string }
> = {
  jetkvm_display_capture: {
    title: "Capture JetKVM display",
    description:
      "Capture a fresh display observation and authorized MCP image.",
  },
  jetkvm_display_status: {
    title: "Read JetKVM display status",
    description:
      "Read qualified signal, resolution, FPS, and read-only EDID status.",
  },
  jetkvm_input_keyboard: {
    title: "Send physical keyboard input",
    description: "Send observation-fenced physical key actions.",
  },
  jetkvm_input_mouse: {
    title: "Send mouse input",
    description: "Send observation-fenced absolute mouse actions.",
  },
  jetkvm_input_paste: {
    title: "Paste text reliably",
    description:
      "Submit observation-fenced text through JetKVM Reliable Paste.",
  },
  jetkvm_input_release: {
    title: "Release JetKVM input",
    description:
      "Close mutation dispatch and release generation-bound input state.",
  },
  jetkvm_power_control: {
    title: "Control JetKVM ATX power",
    description: "Execute one fixed semantic ATX power action.",
  },
  jetkvm_session_connect: {
    title: "Connect JetKVM session",
    description:
      "Acquire an explicit application control session for the configured device.",
  },
  jetkvm_session_reconnect: {
    title: "Reconnect JetKVM session",
    description:
      "Quiesce and replace the current application session generation.",
  },
  jetkvm_session_status: {
    title: "Read JetKVM session status",
    description:
      "Read separate ownership, transport, input, video, and capability facts.",
  },
};

export type ToolCatalogueEntry = {
  readonly name: JetKvmToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodTypeAny;
  readonly outputSchema: z.ZodTypeAny;
};

export const TOOL_CATALOGUE: readonly ToolCatalogueEntry[] = Object.freeze(
  JETKVM_TOOL_NAMES.map((name) =>
    Object.freeze({
      name,
      ...TOOL_PRESENTATION[name],
      inputSchema: TOOL_INPUT_SCHEMAS[name],
      outputSchema: TOOL_RESULT_SCHEMAS[name],
    }),
  ),
);

export const TOOL_CATALOGUE_BY_NAME = Object.freeze(
  Object.fromEntries(
    TOOL_CATALOGUE.map((entry) => [entry.name, entry]),
  ) as Record<JetKvmToolName, ToolCatalogueEntry>,
);
