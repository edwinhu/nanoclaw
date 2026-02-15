import { ASSISTANT_NAME } from './config.js';
import { Channel, NewMessage } from './types.js';
import { logger } from './logger.js';

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map((m) =>
    `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
  );
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(jid: string, text: string): string {
  // Telegram messages don't need a prefix (bot identity is implicit)
  if (jid.startsWith('tg:')) return text;
  return `${ASSISTANT_NAME}: ${text}`;
}

export function findChannel(channels: Channel[], jid: string): Channel | undefined {
  return channels.find((ch) => ch.ownsJid(jid));
}

export async function routeOutbound(channels: Channel[], jid: string, text: string): Promise<void> {
  const channel = findChannel(channels, jid);
  if (!channel) {
    logger.warn({ jid }, 'No channel found for JID');
    return;
  }
  await channel.sendMessage(jid, text);
}
