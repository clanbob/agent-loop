import { readFileSync } from "node:fs";
import path from "node:path";

export function fillPrompt(root: string, name: string, vars: Record<string, string>): string {
  const template = readFileSync(path.join(root, "prompts", `${name}.md`), "utf8");
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
    if (!(key in vars)) throw new Error(`Prompt ${name} uses {{${key}}} but no value was given`);
    return vars[key];
  });
}

export function bulletList(items: string[]): string {
  return items.map((i) => `- ${i}`).join("\n");
}
