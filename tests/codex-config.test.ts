import { describe, expect, it } from "vitest";
import {
  MANAGED_BEGIN,
  MANAGED_END,
  mergeCodexConfig,
} from "../extension/src/codexConfig.ts";

const settings = {
  host: "127.0.0.1",
  port: 4000,
};

describe("mergeCodexConfig", () => {
  it("inserts managed block before first table and keeps other top-level keys", () => {
    const original = `model = "gpt-5.6-sol"
sandbox_mode = "danger-full-access"
notify = ["turn-ended"]

[projects."/tmp"]
trust_level = "trusted"
`;
    const next = mergeCodexConfig(original, settings);
    expect(next).toContain('sandbox_mode = "danger-full-access"');
    expect(next).toContain('notify = ["turn-ended"]');
    expect(next).toContain(MANAGED_BEGIN);
    expect(next).toContain(MANAGED_END);
    expect(next).toContain('model_provider = "zion-pool"');
    expect(next).toContain("[model_providers.zion-pool]");
    expect(next.indexOf("model_provider")).toBeLessThan(next.indexOf("[projects"));
    expect(next.indexOf("[model_providers.zion-pool]")).toBeLessThan(
      next.indexOf("[projects")
    );
    expect((next.match(/model_provider\s*=/g) || []).length).toBe(1);
    expect((next.match(/\[model_providers\.zion-pool\]/g) || []).length).toBe(1);
  });

  it("is idempotent and strips duplicate provider tables", () => {
    const messy = `model = "x"
model_provider = "openai"

[model_providers.zion-pool]
name = "stale"
base_url = "http://old"

[projects."/a"]
trust_level = "trusted"

[model_providers.zion-pool]
name = "dup"
base_url = "http://dup"
`;
    const once = mergeCodexConfig(messy, settings);
    const twice = mergeCodexConfig(once, settings);
    expect(once).toBe(twice);
    expect((once.match(/\[model_providers\.zion-pool\]/g) || []).length).toBe(1);
    expect(once).toContain('base_url = "http://127.0.0.1:4000/backend-api/codex"');
    expect(once).not.toContain("http://old");
    expect(once).not.toContain("http://dup");
  });

  it("does not leak provider keys into a preceding table", () => {
    const original = `[projects."/tmp"]
trust_level = "trusted"
`;
    const next = mergeCodexConfig(original, settings);
    // Managed block must come BEFORE [projects], so model_provider is top-level.
    expect(next.indexOf(MANAGED_BEGIN)).toBeLessThan(next.indexOf("[projects"));
    const projectsSection = next.slice(next.indexOf("[projects"));
    expect(projectsSection).not.toContain("base_url");
    expect(projectsSection).not.toContain("wire_api");
  });
});
