import { z } from "zod";

// --- Config schemas ---

export const ProviderSchema = z.object({
  type: z.enum(["openai", "azure", "anthropic"]).default("openai"),
  base_url: z.string(),
  api_key_env: z.string().optional(),
  bearer_token_env: z.string().optional(),
  wire_api: z.enum(["completions", "responses"]).optional(),
});

export type ProviderConfig = z.infer<typeof ProviderSchema>;

export const ConfigSchema = z.object({
  active: z.object({
    provider: z.string(),
    model: z.string(),
  }),
  providers: z.record(z.string(), ProviderSchema),
  telegram: z.object({
    allowed_user_ids: z.array(z.number()).min(1, "allowlist cannot be empty"),
    token_env: z.string().default("TELEGRAM_BOT_TOKEN"),
  }),
  agents: z.object({
    dir: z.string().default("./agents"),
    default: z.string().default("assistant"),
  }),
  session: z.object({
    history_dir: z.string().default("./sessions"),
    max_messages: z.number().default(200),
  }),
  permissions: z.object({
    mode: z.enum(["approve-all", "readonly-default", "deny-all"]).default("approve-all"),
    timeout_seconds: z.number().default(300),
  }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

// --- Agent types ---

export interface AgentDefinition {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  prompt: string;
}

// --- Session types ---

export interface SessionEntry {
  chatId: number;
  sessionId: string;
  provider: string;
  model: string;
  agentName: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  autoApprovedTools: Set<string>;
  pendingPermission?: PendingPermission;
}

export interface PendingPermission {
  requestId: string;
  chatId: number;
  messageId: number;
  toolName: string;
  description: string;
  resolve: (decision: PermissionDecision) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface PermissionDecision {
  kind: "approved" | "denied-interactively-by-user";
}

// --- Archived session ---

export interface ArchivedSession {
  chatId: number;
  provider: string;
  model: string;
  agentName: string;
  createdAt: number;
  archivedAt: number;
  messages: Array<{ role: string; content: string; timestamp: number }>;
}
