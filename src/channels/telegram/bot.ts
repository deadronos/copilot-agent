import { Bot } from 'grammy';
import type { InboundMessage, PermissionResponse } from '../types.js';
import { createLogger } from '../../logger.js';
import type { AppConfig } from '../../types.js';

const log = createLogger('telegram-bot');

export interface TelegramBotCallbacks {
  onInboundMessage: (msg: InboundMessage) => Promise<void>;
  onCallbackResponse: (response: PermissionResponse) => Promise<void>;
}

export function createTelegramBot(
  config: AppConfig,
  callbacks: TelegramBotCallbacks,
): Bot {
  const token = process.env[config.telegram.token_env];
  if (!token) {
    throw new Error(
      `Telegram bot token not found. Set the ${config.telegram.token_env} environment variable.`,
    );
  }

  const bot = new Bot(token);

  // ── Allowlist middleware ─────────────────────────────────────────
  const allowedIds = new Set(config.telegram.allowed_user_ids);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId === undefined || !allowedIds.has(userId)) {
      log.debug({ userId }, 'Blocked message from non-allowed user');
      return;
    }
    await next();
  });

  // ── Message handler ──────────────────────────────────────────────
  bot.on('message:text', async (ctx) => {
    const msg = ctx.message;
    const replyTo = msg.reply_to_message;

    const inbound: InboundMessage = {
      userId: String(msg.from.id),
      messageId: String(msg.message_id),
      channel: 'telegram',
      text: msg.text,
      replyTo: replyTo
        ? {
            messageId: String(replyTo.message_id),
            text: ('text' in replyTo ? replyTo.text : '') ?? '',
          }
        : undefined,
      meta: {
        chatId: msg.chat.id,
        chatType: msg.chat.type,
        fromUsername: msg.from.username,
      },
    };

    try {
      await callbacks.onInboundMessage(inbound);
    } catch (err) {
      log.error({ err, userId: inbound.userId }, 'Error handling message');
    }
  });

  // ── Callback handler ─────────────────────────────────────────────
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    // Format: "toolCallId:choiceIndex"
    const colonIdx = data.lastIndexOf(':');
    if (colonIdx === -1) {
      await ctx.answerCallbackQuery({ text: 'Unknown action.' });
      return;
    }

    const toolCallId = data.slice(0, colonIdx);
    const choiceIndex = parseInt(data.slice(colonIdx + 1), 10);

    // Map index to PermissionChoice kind
    const choiceKinds = ['allow-once', 'allow-session', 'deny'] as const;
    const kind =
      choiceKinds[choiceIndex] !== undefined
        ? choiceKinds[choiceIndex]
        : 'deny';

    const response: PermissionResponse = {
      toolCallId,
      choice: { kind },
    };

    try {
      await callbacks.onCallbackResponse(response);
    } catch (err) {
      log.error(
        { err, toolCallId },
        'Error handling permission callback',
      );
    }

    // Answer callback to stop the loading spinner on the button
    await ctx.answerCallbackQuery().catch((err: Error) => {
      log.warn({ err: err.message }, 'Failed to answer callback query');
    });
  });

  // ── Error boundary ───────────────────────────────────────────────
  bot.catch((err) => {
    log.error({ err: err.message }, 'Unhandled bot error');
  });

  return bot;
}
