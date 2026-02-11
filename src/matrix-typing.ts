import { MATRIX_ACCESS_TOKEN, MATRIX_HOMESERVER } from './config.js';
import { logger } from './logger.js';

let matrixUserId = '';
// Maps Telegram ghost user ID (from @telegram_NNNNN:*) → Matrix room ID
// For DMs: ghost = remote peer. For groups: ghost members are all participants.
const ghostToRoom = new Map<string, string>();
// Maps channel peer ID (from channel.id "user:NNNNN") → Matrix room ID
const peerToRoom = new Map<string, string>();
let initialized = false;
let telegramBotId = '';

async function matrixFetch(path: string, options?: RequestInit): Promise<Response> {
  const url = `${MATRIX_HOMESERVER}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${MATRIX_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
}

/**
 * Initialize Matrix typing support.
 * Validates the access token, discovers the user ID, and builds mappings
 * from Telegram chat/peer IDs to Matrix room IDs.
 *
 * @param botId - The Telegram bot's numeric user ID (from bot.api.getMe()).
 *   Used to resolve DM rooms: the bot sees chat.id = user's TG ID, but the
 *   bridge sees channelId = user:BOT_ID. We map BOT_ID → roomId, then at
 *   lookup time find the room where the bot is the ghost peer.
 */
export async function initMatrixTyping(botId?: string): Promise<void> {
  if (!MATRIX_ACCESS_TOKEN) {
    logger.info('MATRIX_ACCESS_TOKEN not set, Matrix typing disabled');
    return;
  }

  if (botId) telegramBotId = botId;

  try {
    // Validate token and get user ID
    const whoamiRes = await matrixFetch('/_matrix/client/v3/account/whoami');
    if (!whoamiRes.ok) {
      logger.warn({ status: whoamiRes.status }, 'Matrix token validation failed');
      return;
    }
    const whoami = (await whoamiRes.json()) as { user_id: string };
    matrixUserId = whoami.user_id;
    logger.info({ userId: matrixUserId }, 'Matrix authenticated');

    // Get joined rooms
    const roomsRes = await matrixFetch('/_matrix/client/v3/joined_rooms');
    if (!roomsRes.ok) {
      logger.warn({ status: roomsRes.status }, 'Failed to fetch Matrix rooms');
      return;
    }
    const rooms = (await roomsRes.json()) as { joined_rooms: string[] };

    // For each room, check for bridge state events linking to Telegram
    for (const roomId of rooms.joined_rooms) {
      try {
        const stateRes = await matrixFetch(
          `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`,
        );
        if (!stateRes.ok) continue;

        const events = (await stateRes.json()) as Array<{
          type: string;
          content: Record<string, any>;
          state_key?: string;
        }>;

        // Check if this room has a Telegram bridge
        let isTelegramBridge = false;
        let channelPeerId = '';

        for (const event of events) {
          if (event.type !== 'm.bridge') continue;
          const content = event.content;
          const bridgeName = content['com.beeper.bridge_name'] || content.protocol?.id || '';
          if (bridgeName !== 'telegram') continue;

          isTelegramBridge = true;

          // Extract peer ID from channel.id (e.g., "user:8358920089" → "8358920089")
          const channelId = content.channel?.id;
          if (channelId) {
            const match = channelId.match(/^(?:user|group|channel):(-?\d+)$/);
            if (match) {
              channelPeerId = match[1];
              peerToRoom.set(channelPeerId, roomId);
            }
          }
        }

        if (!isTelegramBridge) continue;

        // Also map ghost member TG IDs → room.
        // Ghost users have format @telegram_NNNNN:beeper.local
        for (const event of events) {
          if (event.type !== 'm.room.member') continue;
          if (event.content?.membership !== 'join') continue;
          const stateKey = event.state_key || '';
          const ghostMatch = stateKey.match(/^@telegram_(-?\d+):/);
          if (ghostMatch) {
            ghostToRoom.set(ghostMatch[1], roomId);
          }
        }

        if (channelPeerId) {
          logger.debug({ peerId: channelPeerId, roomId }, 'Mapped Telegram peer to Matrix room');
        }
      } catch (err) {
        logger.debug({ roomId, err }, 'Failed to fetch room state');
      }
    }

    initialized = true;
    logger.info(
      { peerMappings: peerToRoom.size, ghostMappings: ghostToRoom.size, totalRooms: rooms.joined_rooms.length },
      'Matrix typing initialized',
    );
  } catch (err) {
    logger.warn({ err }, 'Matrix typing init failed, falling back to Telegram-only');
  }
}

/**
 * Resolve a Telegram chat JID to a Matrix room ID.
 *
 * Telegram DMs are asymmetric: the bot sees chat.id = user's TG ID, but the
 * bridge sees the bot as the remote peer (channelId = user:BOT_ID, ghost =
 * @telegram_BOT_ID). For group chats, channel.id matches the TG group ID.
 *
 * Lookup order:
 * 1. peerToRoom (channel peer ID) — works for groups
 * 2. ghostToRoom (ghost member ID) — works for groups
 * 3. DM fallback: if bot ID is known, look up the room where the bot is the
 *    ghost peer — that's the DM room for tg:USER_ID
 */
function resolveRoom(tgChatId: string): string | undefined {
  // Direct match on channel peer ID (groups, channels)
  const byPeer = peerToRoom.get(tgChatId);
  if (byPeer) return byPeer;

  // Match on ghost member ID
  const byGhost = ghostToRoom.get(tgChatId);
  if (byGhost) return byGhost;

  // DM fallback: the bot is a ghost in the user's room.
  // tg:USER_ID → find room where bot (ghost @telegram_BOT_ID) is the peer.
  if (telegramBotId) {
    const byBotGhost = ghostToRoom.get(telegramBotId);
    if (byBotGhost) return byBotGhost;
  }

  return undefined;
}

/**
 * Send a typing notification via Matrix.
 * Looks up the Matrix room ID for the given tg: JID and sends a typing event.
 * Errors are logged and swallowed (typing is best-effort).
 */
export async function setMatrixTyping(
  chatJid: string,
  isTyping: boolean,
): Promise<void> {
  if (!initialized || !matrixUserId) return;

  // Extract numeric Telegram chat ID from "tg:NNNNN"
  const tgChatId = chatJid.replace(/^tg:/, '');
  const roomId = resolveRoom(tgChatId);
  if (!roomId) {
    logger.warn({ chatJid, tgChatId, botId: telegramBotId, peerKeys: [...peerToRoom.keys()], ghostKeys: [...ghostToRoom.keys()] }, 'No Matrix room mapping for Telegram chat');
    return;
  }

  try {
    const res = await matrixFetch(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(matrixUserId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(
          isTyping
            ? { typing: true, timeout: 15000 }
            : { typing: false },
        ),
      },
    );

    if (res.ok) {
      logger.info({ chatJid, roomId: roomId.slice(0, 20), isTyping }, 'Matrix typing sent');
    } else {
      const body = await res.text().catch(() => '');
      logger.warn({ roomId, status: res.status, body: body.slice(0, 200) }, 'Matrix typing request failed');
    }
  } catch (err) {
    logger.warn({ chatJid, err }, 'Matrix typing error');
  }
}
