import { Bot, type Context, type InlineKeyboard } from "grammy";
import { getChildLogger } from "./logger.js";
import type { AppConfig, PermissionDecision } from "./types.js";
import { SessionManager } from "./sessions.js";
import { formatPermissionMessage } from "./permissions.js";
import type { AgentDefinition } from "./types.js";

const log = getChildLogger("telegram");

// Telegram message length limit
const MAX_MESSAGE_LENGTH = 4096;

export class TelegramBot {
  private bot: Bot;
  private config: AppConfig;
  private sessions: SessionManager;
  private agents: Map<string, AgentDefinition>;
  private pendingPermissions = new Map<
    string,
    {
      chatId: number;
      resolve: (decision: PermissionDecision) => void;
      messageId: number;
    }
  >();

  constructor(opts: {
    token: string;
    config: AppConfig;
    sessions: SessionManager;
    agents: Map<string, AgentDefinition>;
  }) {
    this.bot = new Bot(opts.token);
    this.config = opts.config;
    this.sessions = opts.sessions;
    this.agents = opts.agents;

    this.setupMiddleware();
    this.setupCommands();
    this.setupMessageHandler();
    this.setupCallbackHandler();
  }

  /**
   * Middleware: access control — ignore messages from non-allowed users.
   */
  private setupMiddleware(): void {
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      if (!this.config.telegram.allowed_user_ids.includes(userId)) {
        log.debug({ userId }, "Ignoring message from unauthorized user");
        return;
      }

      await next();
    });
  }

  /**
   * Register all bot commands.
   */
  private setupCommands(): void {
    this.bot.command("start", (ctx) => this.handleStart(ctx));
    this.bot.command("new", (ctx) => this.handleNew(ctx));
    this.bot.command("resume", (ctx) => this.handleResume(ctx));
    this.bot.command("provider", (ctx) => this.handleProvider(ctx));
    this.bot.command("model", (ctx) => this.handleModel(ctx));
    this.bot.command("agent", (ctx) => this.handleAgent(ctx));
    this.bot.command("status", (ctx) => this.handleStatus(ctx));
    this.bot.command("approve", (ctx) => this.handleApprove(ctx));
    this.bot.command("deny", (ctx) => this.handleDeny(ctx));
    this.bot.command("help", (ctx) => this.handleHelp(ctx));
  }

  /**
   * Handle plain messages — forward to the agent.
   */
  private setupMessageHandler(): void {
    this.bot.on("message:text", async (ctx) => {
      const chatId = ctx.chat.id;
      const text = ctx.message.text;

      // Skip commands (already handled)
      if (text.startsWith("/")) return;

      // Send typing indicator
      const typingInterval = setInterval(() => {
        ctx.api.sendChatAction(chatId, "typing").catch(() => {});
      }, 4000);
      await ctx.api.sendChatAction(chatId, "typing").catch(() => {});

      try {
        const response = await this.sessions.enqueueMessage(chatId, text);

        clearInterval(typingInterval);

        if (response?.content) {
          await this.sendLongMessage(ctx, response.content);
        } else {
          await ctx.reply("🤔 No response received.");
        }

        // Check if we should suggest /new
        const entry = this.sessions.getEntry(chatId);
        if (entry && entry.messageCount >= this.config.session.max_messages) {
          await ctx.reply(
            `💡 This session has ${entry.messageCount} messages. Consider using /new to start fresh.`
          );
        }
      } catch (err) {
        clearInterval(typingInterval);
        log.error({ chatId, err }, "Error processing message");

        const errMsg = (err as Error).message ?? "Unknown error";
        if (errMsg.includes("unauthorized") || errMsg.includes("401")) {
          await ctx.reply(
            "🔑 Provider rejected the API key. Check config.yaml + .env, then /provider to switch."
          );
        } else if (errMsg.includes("rate") || errMsg.includes("429")) {
          await ctx.reply("⏳ Rate-limited by the provider. Try again in a moment.");
        } else {
          await ctx.reply(`⚠️ Error: ${errMsg.slice(0, 200)}`);
        }
      }
    });
  }

  /**
   * Handle inline callback queries (permission buttons).
   */
  private setupCallbackHandler(): void {
    this.bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;

      if (!data.startsWith("perm:")) {
        await ctx.answerCallbackQuery();
        return;
      }

      const parts = data.split(":");
      const action = parts[1]; // allow-once, allow-session, deny
      const requestId = parts[2];

      const pending = this.pendingPermissions.get(requestId);
      if (!pending) {
        await ctx.answerCallbackQuery({ text: "⏰ This prompt has expired." });
        return;
      }

      // Resolve the permission
      if (action === "allow-once") {
        pending.resolve({ kind: "approved" });
        await ctx.answerCallbackQuery({ text: "✅ Allowed once" });
        await ctx.editMessageText(
          `✅ Allowed: ${this.pendingPermissions.get(requestId)?.chatId ?? "tool"}`
        ).catch(() => {});
      } else if (action === "allow-session") {
        // Add to session auto-approve set
        const entry = this.sessions.getEntry(pending.chatId);
        if (entry) {
          // We need the tool name — store it in the pending permission
          entry.autoApprovedTools.add(
            (pending as any).toolName ?? "unknown"
          );
        }
        pending.resolve({ kind: "approved" });
        await ctx.answerCallbackQuery({ text: "✅ Allowed for this session" });
        await ctx.editMessageText("✅ Allowed for this session").catch(() => {});
      } else if (action === "deny") {
        pending.resolve({ kind: "denied-interactively-by-user" });
        await ctx.answerCallbackQuery({ text: "🚫 Denied" });
        await ctx.editMessageText("🚫 Denied by user").catch(() => {});
      }

      this.pendingPermissions.delete(requestId);
    });
  }

  /**
   * Show a permission prompt in the chat. Returns a promise that resolves
   * when the user clicks a button.
   */
  async showPermissionPrompt(
    chatId: number,
    toolName: string,
    description: string,
    requestId: string
  ): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>(async (resolve) => {
      const msg = formatPermissionMessage(toolName, description);

      // Build inline keyboard
      const keyboard = {
        inline_keyboard: [
          [
            { text: "✅ Allow once", callback_data: `perm:allow-once:${requestId}` },
            { text: "🔁 Allow for session", callback_data: `perm:allow-session:${requestId}` },
          ],
          [{ text: "🚫 Deny", callback_data: `perm:deny:${requestId}` }],
        ],
      };

      try {
        const sent = await this.bot.api.sendMessage(chatId, msg, {
          parse_mode: "Markdown",
          reply_markup: keyboard,
        });

        this.pendingPermissions.set(requestId, {
          chatId,
          resolve,
          messageId: sent.message_id,
          toolName,
        } as any);
      } catch (err) {
        log.error({ chatId, err }, "Failed to send permission prompt");
        resolve({ kind: "denied-interactively-by-user" });
      }
    });
  }

  /**
   * Send a message, splitting if it exceeds Telegram's limit.
   */
  private async sendLongMessage(ctx: Context, text: string): Promise<void> {
    if (text.length <= MAX_MESSAGE_LENGTH) {
      try {
        await ctx.reply(text, { parse_mode: "Markdown" });
      } catch {
        // Fallback without markdown if parsing fails
        await ctx.reply(text);
      }
      return;
    }

    // Split on double newlines, keeping chunks under the limit
    const chunks = splitMessage(text, MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      try {
        await ctx.reply(chunk, { parse_mode: "Markdown" });
      } catch {
        await ctx.reply(chunk);
      }
    }
  }

  // --- Command handlers ---

  private async handleStart(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const activeProvider = this.config.active.provider;
    const activeModel = this.config.active.model;
    const activeAgent = this.config.agents.default;

    const providerList = Object.keys(this.config.providers)
      .map((p) => (p === activeProvider ? `• **${p}** (active)` : `• ${p}`))
      .join("\n");

    const agentList = [...this.agents.keys()]
      .map((a) => (a === activeAgent ? `• **${a}** (active)` : `• ${a}`))
      .join("\n");

    await ctx.reply(
      [
        "👋 **Welcome to Copilot Agent!**",
        "",
        `Provider: **${activeProvider}**`,
        `Model: **${activeModel}**`,
        `Agent: **${activeAgent}**`,
        "",
        "**Available providers:**",
        providerList,
        "",
        "**Available agents:**",
        agentList,
        "",
        "Send any message to start chatting. Use /help for commands.",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  }

  private async handleNew(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const result = await this.sessions.newSession(chatId);
    await ctx.reply(result, { parse_mode: "Markdown" });
  }

  private async handleResume(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const args = (ctx.message?.text ?? "").split(/\s+/).slice(1);
    const index = parseInt(args[0] ?? "1", 10) || 1;
    const result = await this.sessions.resumeSession(chatId, index);
    await ctx.reply(result, { parse_mode: "Markdown" });
  }

  private async handleProvider(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const args = (ctx.message?.text ?? "").split(/\s+/).slice(1);

    if (args.length === 0) {
      const list = Object.keys(this.config.providers)
        .map((p) => `• ${p}`)
        .join("\n");
      await ctx.reply(`**Available providers:**\n${list}\n\nUsage: /provider <name>`, {
        parse_mode: "Markdown",
      });
      return;
    }

    const result = await this.sessions.switchProvider(chatId, args[0]);
    await ctx.reply(result, { parse_mode: "Markdown" });
  }

  private async handleModel(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const args = (ctx.message?.text ?? "").split(/\s+/).slice(1);

    if (args.length === 0) {
      const entry = this.sessions.getEntry(chatId);
      await ctx.reply(
        `Current model: **${entry?.model ?? this.config.active.model}**\n\nUsage: /model <name>`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const result = await this.sessions.switchModel(chatId, args[0]);
    await ctx.reply(result, { parse_mode: "Markdown" });
  }

  private async handleAgent(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const args = (ctx.message?.text ?? "").split(/\s+/).slice(1);

    if (args.length === 0) {
      const list = [...this.agents.entries()]
        .map(([name, agent]) => `• **${name}**: ${agent.description}`)
        .join("\n");
      await ctx.reply(`**Available agents:**\n${list}\n\nUsage: /agent <name>`, {
        parse_mode: "Markdown",
      });
      return;
    }

    const result = await this.sessions.switchAgent(chatId, args[0]);
    await ctx.reply(result, { parse_mode: "Markdown" });
  }

  private async handleStatus(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const status = this.sessions.getStatus(chatId);
    await ctx.reply(status, { parse_mode: "Markdown" });
  }

  private async handleApprove(ctx: Context): Promise<void> {
    // Find the most recent pending permission for this chat
    const chatId = ctx.chat!.id;
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.chatId === chatId) {
        pending.resolve({ kind: "approved" });
        this.pendingPermissions.delete(requestId);
        await ctx.reply("✅ Approved.");
        return;
      }
    }
    await ctx.reply("No pending permission requests.");
  }

  private async handleDeny(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.chatId === chatId) {
        pending.resolve({ kind: "denied-interactively-by-user" });
        this.pendingPermissions.delete(requestId);
        await ctx.reply("🚫 Denied.");
        return;
      }
    }
    await ctx.reply("No pending permission requests.");
  }

  private async handleHelp(ctx: Context): Promise<void> {
    await ctx.reply(
      [
        "**Available commands:**",
        "",
        "/start — Show current config and available options",
        "/new — Start a fresh session",
        "/resume [n] — Resume the n-th most recent session",
        "/provider [name] — List or switch provider",
        "/model [name] — List or switch model",
        "/agent [name] — List or switch agent",
        "/status — Show current session info",
        "/approve — Approve the most recent permission prompt",
        "/deny — Deny the most recent permission prompt",
        "/help — Show this help",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  }

  /**
   * Start the bot (long-polling).
   */
  async start(): Promise<void> {
    await this.bot.start({
      onStart: (botInfo) => {
        log.info({ username: botInfo.username }, "Bot started");
      },
    });
  }

  /**
   * Stop the bot.
   */
  stop(): void {
    this.bot.stop();
  }
}

/**
 * Split a long message into chunks that fit within Telegram's limit.
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < maxLength * 0.5) {
      // If newline is too far back, split at space
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt < maxLength * 0.3) {
      // Hard split as last resort
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
