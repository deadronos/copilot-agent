import type {
  ChannelAdapter,
  ChannelCapabilities,
  InboundMessage,
  OutboundMessage,
  StreamSink,
  PermissionPrompt,
  PermissionResponse,
} from '../types.js';
import type { Bot } from 'grammy';
import { createTelegramBot, type TelegramBotCallbacks } from './bot.js';
import { TelegramStreamSink } from './sink.js';
import { formatPermissionKeyboard } from './format.js';
import { createLogger } from '../../logger.js';
import { loadConfig } from '../../config.js';

const log = createLogger('telegram-adapter');

const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  streaming: true,
  inlineButtons: true,
  messageEdit: true,
  messageHistory: false,
  unlimitedLength: false,
};

export class TelegramAdapter implements ChannelAdapter {
  readonly id = 'telegram';
  readonly capabilities = TELEGRAM_CAPABILITIES;

  private bot: Bot | null = null;
  private messageHandlerCallback:
    | ((msg: InboundMessage) => Promise<void>)
    | null = null;
  private permissionResponseCallback:
    | ((response: PermissionResponse) => Promise<void>)
    | null = null;

  async start(): Promise<void> {
    const config = await loadConfig();

    const callbacks: TelegramBotCallbacks = {
      onInboundMessage: async (msg) => {
        if (this.messageHandlerCallback) {
          await this.messageHandlerCallback(msg);
        }
      },
      onCallbackResponse: async (response) => {
        if (this.permissionResponseCallback) {
          await this.permissionResponseCallback(response);
        }
      },
    };

    this.bot = createTelegramBot(config, callbacks);
    log.info('Starting Telegram bot (long-polling)');
    this.bot.start();
  }

  async stop(): Promise<void> {
    if (this.bot) {
      log.info('Stopping Telegram bot');
      await this.bot.stop();
      this.bot = null;
    }
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandlerCallback = handler;
  }

  onPermissionResponse(
    handler: (response: PermissionResponse) => Promise<void>,
  ): void {
    this.permissionResponseCallback = handler;
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not started');

    const chatId = Number(message.userId);
    const opts: Record<string, unknown> = {};

    if (message.replyToMessageId) {
      opts.reply_to_message_id = Number(message.replyToMessageId);
    }
    if (message.inlineButtons) {
      opts.reply_markup = { inline_keyboard: message.inlineButtons };
    }

    await this.bot.api.sendMessage(chatId, message.text, opts);
  }

  async startStream(replyToMessageId?: string, context?: Record<string, unknown>): Promise<StreamSink> {
    const chatId = context?.chatId as number | undefined;
    if (!chatId) {
      throw new Error(
        'startStream() requires chatId in context — pass message meta',
      );
    }
    return this.startStreamForChat(chatId, replyToMessageId);
  }

  /**
   * Start a stream for a specific chat. Sends a "…" placeholder and returns
   * a sink that edits it in-place.
   */
  async startStreamForChat(
    chatId: number,
    replyToMessageId?: string,
  ): Promise<StreamSink> {
    if (!this.bot) throw new Error('Telegram bot not started');

    const opts: Record<string, unknown> = {};
    if (replyToMessageId) {
      opts.reply_to_message_id = replyToMessageId;
    }

    const msg = await this.bot.api.sendMessage(chatId, '\u2026', opts);
    return new TelegramStreamSink(this.bot.api, chatId, msg.message_id);
  }

  async promptPermission(_prompt: PermissionPrompt): Promise<PermissionResponse> {
    if (!this.bot) throw new Error('Telegram bot not started');

    // This requires chat context — in practice the gateway stores the
    // active chatId per user and the adapter resolves it.
    // For now, this method is called by the gateway which provides
    // the chat context through an extended mechanism.
    //
    // We throw with a helpful message; the real implementation needs
    // a chatId from the session.

    throw new Error(
      'promptPermission() requires chat context — use promptPermissionInChat()',
    );
  }

  /**
   * Send a permission prompt to a specific chat.
   */
  async promptPermissionInChat(
    chatId: number,
    prompt: PermissionPrompt,
  ): Promise<PermissionResponse> {
    if (!this.bot) throw new Error('Telegram bot not started');

    const keyboard = formatPermissionKeyboard(prompt);

    await this.bot.api.sendMessage(
      chatId,
      `🔐 Allow "${prompt.toolName}"?`,
      { reply_markup: { inline_keyboard: keyboard } },
    );

    // Return a promise that resolves when the callback arrives
    return new Promise<PermissionResponse>((resolve) => {
      const originalHandler = this.permissionResponseCallback;

      // Temporarily intercept the next matching permission response
      this.permissionResponseCallback = async (response) => {
        if (response.toolCallId === prompt.toolCallId) {
          this.permissionResponseCallback = originalHandler;
          resolve(response);
        } else if (originalHandler) {
          await originalHandler(response);
        }
      };
    });
  }
}
