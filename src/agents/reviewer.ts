import { writeFileSync } from "node:fs";
import path from "node:path";
import type { McpServers } from "../mcp.ts";
import { askStructured } from "./structured.ts";
import type { Review, StepContext } from "./types.ts";

export async function runReviewer(ctx: StepContext, prompt: string, servers: McpServers = {}): Promise<Review> {
  const review = await askStructured<Review>(ctx, prompt, {
    role: "reviewer", label: "review", schema: "review.schema.json", key: "findings", servers,
    validate(answer) {
      if (!Array.isArray(answer.findings)) throw new Error("findings is not a list");
      const ids = new Set<string>();
      for (const finding of answer.findings) {
        if (typeof finding.id !== "string" || !finding.id.trim() || ids.has(finding.id)) {
          throw new Error("Every finding needs a unique, nonempty id.");
        }
        ids.add(finding.id);
      }
    },
  });
  writeFileSync(path.join(ctx.roundDir, "review.json"), JSON.stringify(review, null, 2), "utf8");
  return review;
}
