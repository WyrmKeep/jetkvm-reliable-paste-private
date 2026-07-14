import "vitest";

declare module "vitest" {
  interface TaskMeta {
    focused_assertion_ids?: readonly string[];
    focused_test_identity?: string;
    story_contract_ids?: readonly string[];
    story_test_identity?: string;
  }
}
