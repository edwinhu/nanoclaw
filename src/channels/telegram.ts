import { Bot } from 'grammy';

import {
  ASSISTANT_NAME,
  TRIGGER_PATTERN,
} from '../config.js';
import {
  getAllRegisteredGroups,
  storeChatMetadata,
  storeMessageDirect,
} from '../db.js';
import type { GroupQueue } from '../group-queue.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';

export interface TelegramDeps {
  queue: GroupQueue;
  advanceCursor: (chatJid: string) => void;
}

export class TelegramChannel implements Channel {
  name = 'Telegram';
  private bot: Bot | null = null;
  private botId = '';

  constructor(
    private botToken: string,
    private deps: TelegramDeps,
  ) {}

  async connect(): Promise<void> {
    const bot = new Bot(this.botToken);
    this.bot = bot;

    // Command to interrupt the running agent (like Ctrl+C)
    bot.command('stop', (ctx) => {
      const chatId = `tg:${ctx.chat.id}`;
      if (this.deps.queue.interruptGroup(chatId)) {
        this.deps.advanceCursor(chatId);
        ctx.reply('Interrupting...');
      } else {
        ctx.reply('Nothing running.');
      }
    });

    // Command to kill container and start fresh on next message
    bot.command('restart', (ctx) => {
      const chatId = `tg:${ctx.chat.id}`;
      if (this.deps.queue.killGroup(chatId)) {
        this.deps.advanceCursor(chatId);
        ctx.reply('Restarting...');
      } else {
        ctx.reply('Nothing running.');
      }
    });

    // Command to get chat ID (useful for registration)
    bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) return;

      const chatId = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatId;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      storeChatMetadata(chatId, timestamp, chatName);

      const registeredGroups = getAllRegisteredGroups();
      const group = registeredGroups[chatId];

      if (!group) {
        logger.debug({ chatId, chatName }, 'Message from unregistered Telegram chat');
        return;
      }

      storeMessageDirect({
        id: msgId,
        chat_jid: chatId,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info({ chatId, chatName, sender: senderName }, 'Telegram message stored');
    });

    // Handle non-text messages with placeholders
    bot.on('message:photo', (ctx) => this.storeNonTextMessage(ctx, '[Photo]'));
    bot.on('message:video', (ctx) => this.storeNonTextMessage(ctx, '[Video]'));
    bot.on('message:voice', (ctx) => this.storeNonTextMessage(ctx, '[Voice message]'));
    bot.on('message:audio', (ctx) => this.storeNonTextMessage(ctx, '[Audio]'));
    bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      this.storeNonTextMessage(ctx, `[Document: ${name}]`);
    });
    bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      this.storeNonTextMessage(ctx, `[Sticker ${emoji}]`);
    });
    bot.on('message:location', (ctx) => this.storeNonTextMessage(ctx, '[Location]'));
    bot.on('message:contact', (ctx) => this.storeNonTextMessage(ctx, '[Contact]'));

    bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    const me = await bot.api.getMe();
    this.botId = String(me.id);

    bot.start({
      onStart: (botInfo) => {
        logger.info({ username: botInfo.username, id: botInfo.id }, 'Telegram bot connected');
        console.log(`\n  Telegram bot: @${botInfo.username}`);
        console.log(`  Send /chatid to the bot to get a chat's registration ID\n`);
      },
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const MAX_LENGTH = 4096;

      const sendChunk = async (chunk: string) => {
        try {
          const html = markdownToTelegramHtml(chunk);
          await this.bot!.api.sendMessage(numericId, html, { parse_mode: 'HTML' });
        } catch {
          await this.bot!.api.sendMessage(numericId, chunk);
        }
      };

      if (text.length <= MAX_LENGTH) {
        await sendChunk(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendChunk(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ chatId: jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ chatId: jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      if (isTyping) {
        await this.bot.api.sendChatAction(numericId, 'typing');
      } else {
        // 'cancel' is undocumented but works — clears the typing indicator
        await this.bot.api.sendChatAction(numericId, 'cancel' as 'typing');
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update Telegram typing');
    }
  }

  getBotId(): string {
    return this.botId;
  }

  private storeNonTextMessage(ctx: any, placeholder: string): void {
    const chatId = `tg:${ctx.chat.id}`;
    const registeredGroups = getAllRegisteredGroups();
    if (!registeredGroups[chatId]) return;

    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const senderName =
      ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
    const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

    storeChatMetadata(chatId, timestamp);
    storeMessageDirect({
      id: ctx.message.message_id.toString(),
      chat_jid: chatId,
      sender: ctx.from?.id?.toString() || '',
      sender_name: senderName,
      content: `${placeholder}${caption}`,
      timestamp,
      is_from_me: false,
    });
  }
}

/** Convert standard Markdown to Telegram-compatible HTML. */
function markdownToTelegramHtml(md: string): string {
  let text = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const codeBlocks: string[] = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) => {
    codeBlocks.push(`<pre>${code.trimEnd()}</pre>`);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(`<code>${code}</code>`);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  text = text.replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>');
  text = text.replace(/__(.+?)__/gs, '<b>$1</b>');
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');
  text = text.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<i>$1</i>');
  text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');
  text = text.replace(/^&gt;\s?(.+)$/gm, '<i>$1</i>');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  text = text.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i)]);
  text = text.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCodes[parseInt(i)]);

  return text.trim();
}
