import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("follow-up email provider", () => {
  // Code only: comments may (and do) explain that Anthropic is NOT used.
  const read = (f: string) =>
    readFileSync(join(process.cwd(), f), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
      .join("\n");

  it("the generator has no Anthropic dependency: OpenAI + OPENAI_API_KEY only", () => {
    const src = read("src/lib/ai/followup-email.ts");
    expect(src).not.toMatch(/anthropic/i);
    expect(src).toContain("process.env.OPENAI_API_KEY");
    expect(src).toContain("https://api.openai.com/v1/chat/completions");
  });

  it("nothing else on the follow-up path reads ANTHROPIC_API_KEY", () => {
    for (const f of [
      "src/lib/server/followup-context.ts",
      "src/app/api/admin/one-on-one-meetings/[id]/followup/route.ts",
    ]) {
      expect(read(f), f).not.toMatch(/anthropic/i);
    }
  });
});
