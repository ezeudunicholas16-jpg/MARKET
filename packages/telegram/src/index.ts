export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from?: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface ParsedTelegramCommand {
  command: string;
  args: string[];
  rawArgs: string;
}

export interface TelegramSendResult {
  ok: boolean;
  mock: boolean;
  messageId?: number;
  description?: string;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export function parseTelegramCommand(text: string): ParsedTelegramCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [rawCommand = "", ...args] = trimmed.split(/\s+/);
  const command = rawCommand.split("@")[0]?.toLowerCase() ?? "";
  return {
    command,
    args,
    rawArgs: args.join(" ")
  };
}

export class TelegramClient {
  constructor(
    private readonly token?: string,
    private readonly defaultChatId?: string
  ) {}

  async sendMessage(input: {
    chatId?: string | number;
    text: string;
    parseMode?: "Markdown" | "HTML";
    replyMarkup?: TelegramInlineKeyboardMarkup;
  }): Promise<TelegramSendResult> {
    const chatId = input.chatId ?? this.defaultChatId;
    if (!this.token || !chatId) {
      return {
        ok: true,
        mock: true,
        description: "Telegram token or chat id not configured; message was not sent externally."
      };
    }

    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: input.text,
        parse_mode: input.parseMode,
        reply_markup: input.replyMarkup
      })
    });

    const payload = (await response.json()) as {
      ok: boolean;
      description?: string;
      result?: { message_id?: number };
    };

    return {
      ok: payload.ok,
      mock: false,
      messageId: payload.result?.message_id,
      description: payload.description
    };
  }

  async answerCallbackQuery(input: { callbackQueryId: string; text?: string }): Promise<TelegramSendResult> {
    if (!this.token) {
      return {
        ok: true,
        mock: true,
        description: "Telegram token not configured; callback acknowledgement was not sent externally."
      };
    }

    const response = await fetch(`https://api.telegram.org/bot${this.token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        callback_query_id: input.callbackQueryId,
        text: input.text
      })
    });
    const payload = (await response.json()) as { ok: boolean; description?: string };
    return {
      ok: payload.ok,
      mock: false,
      description: payload.description
    };
  }
}

export function extractMessageText(update: TelegramUpdate): { chatId: number; userId?: number; text: string } | null {
  if (!update.message?.text) {
    return null;
  }

  return {
    chatId: update.message.chat.id,
    userId: update.message.from?.id,
    text: update.message.text
  };
}

export function extractCallbackData(
  update: TelegramUpdate
): { callbackQueryId: string; chatId?: number; userId?: number; data: string } | null {
  if (!update.callback_query?.data) {
    return null;
  }

  return {
    callbackQueryId: update.callback_query.id,
    chatId: update.callback_query.message?.chat.id,
    userId: update.callback_query.from?.id,
    data: update.callback_query.data
  };
}
