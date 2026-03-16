import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';
import { logger } from './logger.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(jid: string, rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  // Telegram messages don't need a prefix (bot identity is implicit)
  if (jid.startsWith('tg:')) return text;
  return text;
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

export async function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const formatted = formatOutbound(jid, text);
  if (!formatted) return;

  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) {
    logger.warn({ jid }, 'No channel found for JID');
    return;
  }
  await channel.sendMessage(jid, formatted);
}
