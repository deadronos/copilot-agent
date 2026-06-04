import type { InlineKeyboardButton } from 'grammy/types';
import type { PermissionPrompt } from '../../types.js';

/**
 * Build an inline keyboard markup from a permission prompt's choices.
 * Each choice maps to a row with one button.
 */
export function formatPermissionKeyboard(
  prompt: PermissionPrompt,
): InlineKeyboardButton[][] {
  return prompt.choices.map((choice, index) => [
    {
      text: choiceLabel(choice.kind),
      callback_data: `${prompt.toolCallId}:${index}`,
    },
  ]);
}

function choiceLabel(kind: string): string {
  switch (kind) {
    case 'allow-once':
      return 'Allow once';
    case 'allow-session':
      return 'Allow for session';
    case 'deny':
      return 'Deny';
    default:
      return kind;
  }
}

/**
 * Escape Telegram's MarkdownV2 special characters.
 * See https://core.telegram.org/bots/api#markdownv2-style
 */
const MARKDOWN_SPECIALS = /[_*[\]()~`>#+\-=|{}.!]/g;

export function escapeTelegramMarkdown(text: string): string {
  return text.replace(MARKDOWN_SPECIALS, '\\$&');
}
