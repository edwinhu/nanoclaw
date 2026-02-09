import { Bot } from 'grammy';
import {
  ASSISTANT_NAME,
  TRIGGER_PATTERN,
} from './config.js';
import {
  getAllRegisteredGroups,
  storeChatMetadata,
  storeMessageDirect,
} from './db.js';
import type { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';

let bot: Bot | null = null;
let queueRef: GroupQueue | null = null;
let advanceCursorFn: ((chatJid: string) => void) | null = null;

/** Store a placeholder message for non-text content (photos, voice, etc.) */
function storeNonTextMessage(ctx: any, placeholder: string): void {
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

export async function connectTelegram(
  botToken: string,
  queue?: GroupQueue,
  advanceCursor?: (chatJid: string) => void,
): Promise<void> {
  bot = new Bot(botToken);
  if (queue) queueRef = queue;
  if (advanceCursor) advanceCursorFn = advanceCursor;

  // Command to interrupt the running agent (like Ctrl+C)
  bot.command('stop', (ctx) => {
    const chatId = `tg:${ctx.chat.id}`;
    if (queueRef?.interruptGroup(chatId)) {
      advanceCursorFn?.(chatId);
      ctx.reply('Interrupting...');
    } else {
      ctx.reply('Nothing running.');
    }
  });

  // Command to kill container and start fresh on next message
  bot.command('restart', (ctx) => {
    const chatId = `tg:${ctx.chat.id}`;
    if (queueRef?.killGroup(chatId)) {
      advanceCursorFn?.(chatId);
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
    // Skip commands
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

    // Determine chat name
    const chatName =
      ctx.chat.type === 'private'
        ? senderName
        : (ctx.chat as any).title || chatId;

    // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
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

    // Store chat metadata for discovery
    storeChatMetadata(chatId, timestamp, chatName);

    // Check if this chat is registered
    const registeredGroups = getAllRegisteredGroups();
    const group = registeredGroups[chatId];

    if (!group) {
      logger.debug(
        { chatId, chatName },
        'Message from unregistered Telegram chat',
      );
      return;
    }

    // Store message — startMessageLoop() will pick it up
    storeMessageDirect({
      id: msgId,
      chat_jid: chatId,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatId, chatName, sender: senderName },
      'Telegram message stored',
    );
  });

  // Handle non-text messages with placeholders
  bot.on('message:photo', (ctx) => storeNonTextMessage(ctx, '[Photo]'));
  bot.on('message:video', (ctx) => storeNonTextMessage(ctx, '[Video]'));
  bot.on('message:voice', (ctx) => storeNonTextMessage(ctx, '[Voice message]'));
  bot.on('message:audio', (ctx) => storeNonTextMessage(ctx, '[Audio]'));
  bot.on('message:document', (ctx) => {
    const name = ctx.message.document?.file_name || 'file';
    storeNonTextMessage(ctx, `[Document: ${name}]`);
  });
  bot.on('message:sticker', (ctx) => {
    const emoji = ctx.message.sticker?.emoji || '';
    storeNonTextMessage(ctx, `[Sticker ${emoji}]`);
  });
  bot.on('message:location', (ctx) => storeNonTextMessage(ctx, '[Location]'));
  bot.on('message:contact', (ctx) => storeNonTextMessage(ctx, '[Contact]'));

  // Handle errors gracefully
  bot.catch((err) => {
    logger.error({ err: err.message }, 'Telegram bot error');
  });

  // Start polling
  bot.start({
    onStart: (botInfo) => {
      logger.info(
        { username: botInfo.username, id: botInfo.id },
        'Telegram bot connected',
      );
      console.log(`\n  Telegram bot: @${botInfo.username}`);
      console.log(
        `  Send /chatid to the bot to get a chat's registration ID\n`,
      );
    },
  });
}

/** Convert standard Markdown to Telegram-compatible HTML. */
function markdownToTelegramHtml(md: string): string {
  // Escape HTML entities first so inserted tags survive
  let text = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Protect code blocks from further processing
  const codeBlocks: string[] = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) => {
    codeBlocks.push(`<pre>${code.trimEnd()}</pre>`);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Protect inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(`<code>${code}</code>`);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // Headers → bold (Telegram has no native header support)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Bold **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>');
  text = text.replace(/__(.+?)__/gs, '<b>$1</b>');

  // Italic *text* (single asterisk, not inside bold)
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');

  // Strikethrough ~~text~~
  text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore protected blocks
  text = text.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i)]);
  text = text.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCodes[parseInt(i)]);

  return text.trim();
}

export async function sendTelegramMessage(
  chatId: string,
  text: string,
): Promise<void> {
  if (!bot) {
    logger.warn('Telegram bot not initialized');
    return;
  }

  try {
    const numericId = chatId.replace(/^tg:/, '');

    // Telegram has a 4096 character limit per message — split if needed
    const MAX_LENGTH = 4096;
    const sendChunk = async (chunk: string) => {
      try {
        const html = markdownToTelegramHtml(chunk);
        await bot!.api.sendMessage(numericId, html, { parse_mode: 'HTML' });
      } catch {
        // HTML parse failed — send as plain text
        await bot!.api.sendMessage(numericId, chunk);
      }
    };
    if (text.length <= MAX_LENGTH) {
      await sendChunk(text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendChunk(text.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info({ chatId, length: text.length }, 'Telegram message sent');
  } catch (err) {
    logger.error({ chatId, err }, 'Failed to send Telegram message');
  }
}

export async function setTelegramTyping(chatId: string): Promise<void> {
  if (!bot) return;
  try {
    const numericId = chatId.replace(/^tg:/, '');
    await bot.api.sendChatAction(numericId, 'typing');
    logger.info({ chatId }, 'Telegram typing indicator sent');
  } catch (err) {
    logger.debug({ chatId, err }, 'Failed to send Telegram typing indicator');
  }
}

export function isTelegramConnected(): boolean {
  return bot !== null;
}

export function stopTelegram(): void {
  if (bot) {
    bot.stop();
    bot = null;
    logger.info('Telegram bot stopped');
  }
}
