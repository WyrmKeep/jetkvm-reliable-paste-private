import { describe, expect, it } from "vitest";

import { JETKVM_TOOL_NAMES } from "../domain.js";
import { TOOL_CATALOGUE, TOOL_CATALOGUE_BY_NAME } from "./toolCatalogue.js";

describe("MCP tool catalogue", () => {
  it("contains exactly the sorted canonical ten tools", () => {
    expect(TOOL_CATALOGUE.map(({ name }) => name)).toEqual(JETKVM_TOOL_NAMES);
    expect(Object.keys(TOOL_CATALOGUE_BY_NAME)).toEqual(JETKVM_TOOL_NAMES);
    expect(TOOL_CATALOGUE).toHaveLength(10);
  });

  it("publishes strict input and output schemas for every tool", () => {
    for (const entry of TOOL_CATALOGUE) {
      expect(entry).toEqual(
        expect.objectContaining({
          name: entry.name,
          title: expect.any(String),
          description: expect.any(String),
          inputSchema: expect.any(Object),
          outputSchema: expect.any(Object),
        }),
      );
      expect(entry.inputSchema.safeParse({ unknown: true }).success).toBe(
        false,
      );
      expect(entry.outputSchema.safeParse({ unknown: true }).success).toBe(
        false,
      );
      expect(TOOL_CATALOGUE_BY_NAME[entry.name]).toBe(entry);
    }
  });

  it("does not expose obsolete or hidden registrations", () => {
    const names = TOOL_CATALOGUE.map(({ name }) => name as string);
    expect(names).not.toEqual(
      expect.arrayContaining([
        "computer_screenshot",
        "computer_actions",
        "computer_paste_text",
        "computer_status",
        "computer_release_input",
        "jetkvm_virtual_media",
        "jetkvm_execute",
      ]),
    );
  });
});
