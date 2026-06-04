import { Bot, type Context } from 'grammy';
import { getChildLogger } from './logger.js';
import type { AppConfig, PermissionDecision } from './types.js';
import { type SessionManager } from './sessions.js';
import { formatPermissionMessage } from './permissions.js';
import { TelegramStreamSink } from './streaming.js';
import type { AgentDefinition } from './types.js';

const log = getChildLogger('telegram');

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
      toolName: string;
    }
  >();
  /**
   * The in-flight `TelegramStreamSink` for each chat. When a new user
   * message arrives while a previous response is still streaming, we
   * abort the previous sink and start a fresh one so the user only ever
   * sees one live draft message at a time.
   */
  private activeStreams = new Map<number, TelegramStreamSink>();

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
        log.debug({ userId }, 'Ignoring message from unauthorized user');
        return;
      }

      await next();
    });
  }

  /**
   * Register all bot commands.
   */
  private setupCommands(): void {
    this.bot.command('start', (ctx) => this.handleStart(ctx));
    this.bot.command('new', (ctx) => this.handleNew(ctx));
    this.bot.command('resume', (ctx) => this.handleResume(ctx));
    this.bot.command('provider', (ctx) => this.handleProvider(ctx));
    this.bot.command('model', (ctx) => this.handleModel(ctx));
    this.bot.command('agent', (ctx) => this.handleAgent(ctx));
    this.bot.command('status', (ctx) => this.handleStatus(ctx));
    this.bot.command('approve', (ctx) => this.handleApprove(ctx));
    this.bot.command('deny', (ctx) => this.handleDeny(ctx));
    this.bot.command('help', (ctx) => this.handleHelp(ctx));
  }

  /**
   * Handle plain messages — forward to the agent.
   */
  private setupMessageHandler(): void {
    this.bot.on('message:text', async (ctx) => {
      const chatId = ctx.chat.id;
      const text = ctx.message.text;

      // Skip commands (already handled)
      if (text.startsWith('/')) return;

      // If a previous response is still streaming for this chat, abort
      // it so the user sees exactly one live draft at a time.
      const previousStream = this.activeStreams.get(chatId);
      if (previousStream) {
        previousStream.abort();
        this.activeStreams.delete(chatId);
      }

      // Create and seed a fresh stream sink for this user message. The
      // session manager will pipe assistant deltas and tool events to it
      // via the per-chat `activeSinks` map.
      const stream = new TelegramStreamSink(this.bot, chatId, null);
      this.activeStreams.set(chatId, stream);
      await stream.start();

      // Keep the typing indicator alive while the agent is working.
      const typingInterval = setInterval(() => {
        ctx.api.sendChatAction(chatId, 'typing').catch(() => {});
      }, 4000);
      await ctx.api.sendChatAction(chatId, 'typing').catch(() => {});

      try {
        const response = await this.sessions.enqueueMessage(chatId, text, stream);

        clearInterval(typingInterval);
        // Make sure the final draft is flushed before we tear down.
        await stream.flushNow();

        // If the response was empty (model produced no text — common on
        // some tool-only turns), leave a hint so the user isn't staring
        // at a "…" message.
        if (!response?.content) {
          const msgId = stream.messageIdForEdit();
          if (msgId != null) {
            try {
              await this.bot.api.editMessageText(chatId, msgId, '🤔 No response received.');
            } catch {
              // Ignore — the stream sink already swallows edit errors.
            }
          }
        }

        // Check if we should suggest /new
        const entry = this.sessions.getEntry(chatId);
        if (entry && entry.messageCount >= this.config.session.max_messages) {
          await ctx.reply(
            `💡 This session has ${entry.messageCount} messages. Consider using /new to start fresh.`,
          );
        }
      } catch (err) {
        clearInterval(typingInterval);
        await stream.flushNow().catch(() => {});
        log.error({ chatId, err }, 'Error processing message');

        // If we errored out, the SDK session is likely dead. Any pending
        // permission prompts for this chat are now orphans — the user
        // could click them but the SDK won't act on the decision. Cancel
        // them so the user gets clear feedback and the next message can
        // start a fresh session.
        const cancelled = this.cancelPendingPermissions(chatId, 'agent errored out');

        const errMsg = (err as Error).message ?? 'Unknown error';
        const errMsgId = stream.messageIdForEdit();
        if (errMsgId != null) {
          try {
            await this.bot.api.editMessageText(
              chatId,
              errMsgId,
              `⚠️ Error: ${errMsg.slice(0, 500)}` +
                (cancelled > 0 ? '\n\n_Pending permission prompts cleared._' : ''),
            );
          } catch {
            // If the edit fails, fall back to a fresh message so the user
            // always sees the error.
            await ctx.reply(`⚠️ Error: ${errMsg.slice(0, 200)}`).catch(() => {});
          }
        } else {
          await ctx.reply(`⚠️ Error: ${errMsg.slice(0, 200)}`).catch(() => {});
        }
      } finally {
        this.activeStreams.delete(chatId);
        stream.abort();
      }
    });
  }

  /**
   * Handle inline callback queries (permission buttons).
   */
  private setupCallbackHandler(): void {
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      log.info(
        { data, callbackQueryId: ctx.callbackQuery.id, chatId: ctx.chat?.id },
        'Callback query received',
      );

      if (!data.startsWith('perm:')) {
        await ctx.answerCallbackQuery().catch((err) => {
          log.warn({ err }, 'answerCallbackQuery failed (non-perm callback)');
        });
        return;
      }

      const parts = data.split(':');
      const action = parts[1]; // allow-once, allow-session, deny
      const requestId = parts[2];

      const pending = this.pendingPermissions.get(requestId);
      if (!pending) {
        await ctx.answerCallbackQuery({ text: '⏰ This prompt has expired.' }).catch((err) => {
          log.warn({ requestId, err }, 'answerCallbackQuery failed on expired prompt');
        });
        return;
      }

      try {
        // Resolve the permission FIRST so the SDK unblocks, then do the UI
        // follow-ups. Telegram only honours answerCallbackQuery for ~30s; if
        // the user clicked late, the resolve still works but the toast/edit
        // may fail. Catch those failures — never let them crash the bot.
        if (action === 'allow-once') {
          pending.resolve({ kind: 'allow-once' });
        } else if (action === 'allow-session') {
          const entry = this.sessions.getEntry(pending.chatId);
          if (entry) {
            entry.autoApprovedTools.add(pending.toolName);
          }
          pending.resolve({ kind: 'allow-session' });
        } else if (action === 'deny') {
          pending.resolve({ kind: 'deny' });
        } else {
          await ctx.answerCallbackQuery({ text: '❓ Unknown action.' }).catch((err) => {
            log.warn({ requestId, action, err }, 'answerCallbackQuery failed');
          });
          return;
        }

        this.pendingPermissions.delete(requestId);

        const toast =
          action === 'allow-once'
            ? '✅ Allowed once'
            : action === 'allow-session'
              ? '✅ Allowed for this session'
              : '🚫 Denied';

        await ctx.answerCallbackQuery({ text: toast }).catch((err) => {
          log.warn(
            { requestId, err },
            'answerCallbackQuery failed (query likely expired) — promise already resolved',
          );
        });

        await ctx.editMessageText(toast).catch((err) => {
          log.debug({ requestId, err }, 'editMessageText failed (query likely expired)');
        });
      } catch (err) {
        // Last-resort safety net. Anything thrown above (e.g. bugs in
        // session manager accessors) is logged here so the bot stays alive.
        log.error({ requestId, action, err }, 'Unhandled error in permission callback');
        await ctx.answerCallbackQuery({ text: '⚠️ Internal error.' }).catch(() => {});
      }
    });

    // Catch-all error boundary for any other callback_query handler that
    // might be added later. Without this, an unhandled rejection in
    // long-running grammY middleware can crash the whole bot.
    this.bot.catch((err) => {
      log.error({ err }, 'Unhandled grammY error');
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
    requestId: string,
  ): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>(async (resolve) => {
      const msg = formatPermissionMessage(toolName, description);

      // Build inline keyboard
      const keyboard = {
        inline_keyboard: [
          [
            { text: '✅ Allow once', callback_data: `perm:allow-once:${requestId}` },
            { text: '🔁 Allow for session', callback_data: `perm:allow-session:${requestId}` },
          ],
          [{ text: '🚫 Deny', callback_data: `perm:deny:${requestId}` }],
        ],
      };

      try {
        const sent = await this.bot.api.sendMessage(chatId, msg, {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });

        this.pendingPermissions.set(requestId, {
          chatId,
          resolve,
          messageId: sent.message_id,
          toolName,
        });
      } catch (err) {
        log.error({ chatId, err }, 'Failed to send permission prompt');
        resolve({ kind: 'deny' });
      }
    });
  }

  /**
   * Cancel all in-flight permission prompts for a chat, resolving them
   * with `deny` so any awaiting SDK call unblocks. Returns the number of
   * prompts cancelled. Use this when the SDK session is known to be dead
   * (e.g. the agent loop errored out) so the user isn't left with
   * orphaned buttons that look like they should do something.
   */
  private cancelPendingPermissions(chatId: number, reason: string): number {
    let cancelled = 0;
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.chatId === chatId) {
        log.info({ requestId, chatId, reason }, 'Cancelling orphaned permission prompt');
        try {
          pending.resolve({ kind: 'deny' });
        } catch (err) {
          log.warn({ requestId, err }, 'Failed to resolve cancelled permission');
        }
        this.pendingPermissions.delete(requestId);
        cancelled++;
      }
    }
    return cancelled;
  }

  /**
   * Send a message, splitting if it exceeds Telegram's limit.
   */
  private async sendLongMessage(ctx: Context, text: string): Promise<void> {
    if (text.length <= MAX_MESSAGE_LENGTH) {
      try {
        await ctx.reply(text, { parse_mode: 'Markdown' });
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
        await ctx.reply(chunk, { parse_mode: 'Markdown' });
      } catch {
        await ctx.reply(chunk);
      }
    }
  }

  // --- Command handlers ---

  private async handleStart(ctx: Context): Promise<void> {
    const activeProvider = this.config.active.provider;
    const activeModel = this.config.active.model;
    const activeAgent = this.config.agents.default;

    const providerList = Object.keys(this.config.providers)
      .map((p) => (p === activeProvider ? `• **${p}** (active)` : `• ${p}`))
      .join('\n');

    const agentList = [...this.agents.keys()]
      .map((a) => (a === activeAgent ? `• **${a}** (active)` : `• ${a}`))
      .join('\n');

    await ctx.reply(
      [
        '👋 **Welcome to Copilot Agent!**',
        '',
        `Provider: **${activeProvider}**`,
        `Model: **${activeModel}**`,
        `Agent: **${activeAgent}**`,
        '',
        '**Available providers:**',
        providerList,
        '',
        '**Available agents:**',
        agentList,
        '',
        'Send any message to start chatting. Use /help for commands.',
      ].join('\n'),
      { parse_mode: 'Markdown' },
    );
  }

  private async handleNew(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const result = await this.sessions.newSession(chatId);
    await ctx.reply(result, { parse_mode: 'Markdown' });
  }

  private async handleResume(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const args = (ctx.message?.text ?? '').split(/\s+/).slice(1);
    const index = parseInt(args[0] ?? '1', 10) || 1;
    const result = await this.sessions.resumeSession(chatId, index);
    await ctx.reply(result, { parse_mode: 'Markdown' });
  }

  private async handleProvider(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const args = (ctx.message?.text ?? '').split(/\s+/).slice(1);

    if (args.length === 0) {
      const list = Object.keys(this.config.providers)
        .map((p) => `• ${p}`)
        .join('\n');
      await ctx.reply(`**Available providers:**\n${list}\n\nUsage: /provider <name>`, {
        parse_mode: 'Markdown',
      });
      return;
    }

    const result = await this.sessions.switchProvider(chatId, args[0]);
    await ctx.reply(result, { parse_mode: 'Markdown' });
  }

  private async handleModel(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const args = (ctx.message?.text ?? '').split(/\s+/).slice(1);

    if (args.length === 0) {
      const entry = this.sessions.getEntry(chatId);
      await ctx.reply(
        `Current model: **${entry?.model ?? this.config.active.model}**\n\nUsage: /model <name>`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    const result = await this.sessions.switchModel(chatId, args[0]);
    await ctx.reply(result, { parse_mode: 'Markdown' });
  }

  private async handleAgent(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const args = (ctx.message?.text ?? '').split(/\s+/).slice(1);

    if (args.length === 0) {
      const list = [...this.agents.entries()]
        .map(([name, agent]) => `• **${name}**: ${agent.description}`)
        .join('\n');
      await ctx.reply(`**Available agents:**\n${list}\n\nUsage: /agent <name>`, {
        parse_mode: 'Markdown',
      });
      return;
    }

    const result = await this.sessions.switchAgent(chatId, args[0]);
    await ctx.reply(result, { parse_mode: 'Markdown' });
  }

  private async handleStatus(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const status = this.sessions.getStatus(chatId);
    await ctx.reply(status, { parse_mode: 'Markdown' });
  }

  private async handleApprove(ctx: Context): Promise<void> {
    // Find the most recent pending permission for this chat
    const chatId = ctx.chat!.id;
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.chatId === chatId) {
        pending.resolve({ kind: 'allow-once' });
        this.pendingPermissions.delete(requestId);
        await ctx.reply('✅ Approved.');
        return;
      }
    }
    await ctx.reply('No pending permission requests.');
  }

  private async handleDeny(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.chatId === chatId) {
        pending.resolve({ kind: 'deny' });
        this.pendingPermissions.delete(requestId);
        await ctx.reply('🚫 Denied.');
        return;
      }
    }
    await ctx.reply('No pending permission requests.');
  }

  private async handleHelp(ctx: Context): Promise<void> {
    await ctx.reply(
      [
        '**Available commands:**',
        '',
        '/start — Show current config and available options',
        '/new — Start a fresh session',
        '/resume [n] — Resume the n-th most recent session',
        '/provider [name] — List or switch provider',
        '/model [name] — List or switch model',
        '/agent [name] — List or switch agent',
        '/status — Show current session info',
        '/approve — Approve the most recent permission prompt',
        '/deny — Deny the most recent permission prompt',
        '/help — Show this help',
      ].join('\n'),
      { parse_mode: 'Markdown' },
    );
  }

  /**
   * Start the bot (long-polling).
   */
  async start(): Promise<void> {
    await this.bot.start({
      onStart: (botInfo) => {
        log.info({ username: botInfo.username }, 'Bot started');
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
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < maxLength * 0.5) {
      // If newline is too far back, split at space
      splitAt = remaining.lastIndexOf(' ', maxLength);
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
