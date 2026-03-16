/**
 * Step: groups — List group metadata from the local DB.
 * Telegram and other token-based channels discover group names at runtime —
 * no upfront sync needed. Use --list to query the local DB.
 * Replaces 05-sync-groups.sh + 05b-list-groups.sh
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

function parseArgs(args: string[]): { list: boolean; limit: number } {
  let list = false;
  let limit = 30;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list') list = true;
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    }
  }
  return { list, limit };
}

export async function run(args: string[]): Promise<void> {
  const { list, limit } = parseArgs(args);

  if (list) {
    await listGroups(limit);
    return;
  }

  // No upfront sync needed for Telegram/token-based channels — names are
  // discovered at runtime when messages arrive.
  logger.info('Group sync not required — channels discover names at runtime');
  emitStatus('SYNC_GROUPS', {
    SYNC: 'skipped',
    GROUPS_IN_DB: 0,
    REASON: 'not_required',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

async function listGroups(limit: number): Promise<void> {
  const dbPath = path.join(STORE_DIR, 'messages.db');

  if (!fs.existsSync(dbPath)) {
    console.error('ERROR: database not found');
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      `SELECT jid, name FROM chats
     WHERE jid LIKE '%@g.us' AND jid <> '__group_sync__' AND name <> jid
     ORDER BY last_message_time DESC
     LIMIT ?`,
    )
    .all(limit) as Array<{ jid: string; name: string }>;
  db.close();

  for (const row of rows) {
    console.log(`${row.jid}|${row.name}`);
  }
}
