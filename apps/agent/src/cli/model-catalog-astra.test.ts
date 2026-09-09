import { describe, expect, it } from "vitest";

// Exercise the same ingest heuristics used by discoverCodexCapability without spawning Codex.
function codexModelSupportsFast(row: Record<string, unknown>): boolean {
  const tiers = row.service_tiers || row.serviceTiers;
  if (Array.isArray(tiers)) {
    if (tiers.some((tier) => {
      const id = typeof tier === "string" ? tier : String((tier as { id?: string; tier?: string })?.id || (tier as { tier?: string })?.tier || "").trim();
      return id === "priority" || id === "fast";
    })) return true;
  }
  const slug = String(row.slug || row.id || row.model || "").trim().toLowerCase();
  return /gpt-5|gpt-6|codex|o3|o4/.test(slug);
}

describe("codex gpt-6-astra catalog support", () => {
  it("treats gpt-6-astra Fast tiers as supportsFast", () => {
    expect(codexModelSupportsFast({
      slug: "gpt-6-astra",
      service_tiers: [{ id: "priority", name: "Fast" }],
      additional_speed_tiers: ["fast"]
    })).toBe(true);
    expect(codexModelSupportsFast({ slug: "gpt-6-astra" })).toBe(true);
    expect(codexModelSupportsFast({ slug: "some-local-llama" })).toBe(false);
  });
});
