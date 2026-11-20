export const ROLES = ["judge", "builder", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export const PROVIDERS = ["antigravity", "claude", "codex"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_NAMES: Record<Provider, string> = {
  antigravity: "Antigravity",
  claude: "Claude",
  codex: "Codex",
};

// Runs and preferences saved before provider selection only have a model and effort.
export interface AgentChoice {
  provider?: Provider;
  model: string | null;
  effort: string | null;
}

export type AgentChoices = Record<Role, AgentChoice>;

export const DEFAULT_CHOICES = {
  judge: { provider: "antigravity", model: "gemini-4-neon", effort: "medium" },
  builder: { provider: "claude", model: "opus", effort: "medium" },
  reviewer: { provider: "codex", model: "gpt-6.2-astra", effort: "medium" },
} as const satisfies AgentChoices;
