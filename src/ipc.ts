import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import {
  AvailableGroup,
  writeGroupsSnapshot,
} from './container-runner.js';
import {
  createTask,
  deleteTask,
  getTaskById,
  registerCompanionSession,
  updateTask,
} from './db.js';
import { logger } from './logger.js';
import { findChannel, formatOutbound } from './router.js';
import { Channel, RegisteredGroup } from './types.js';
import { TypingManager } from './typing.js';

export interface IpcDeps {
  channels: Channel[];
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  typingManager: TypingManager;
}

/** Process all .json files in a directory, moving failures to an error directory. */
async function processIpcDir(
  dir: string,
  sourceGroup: string,
  errorDir: string,
  handler: (data: any) => Promise<void>,
): Promise<void> {
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      await handler(data);
      fs.unlinkSync(filePath);
    } catch (err) {
      logger.error({ file, sourceGroup, err }, 'Error processing IPC file');
      fs.mkdirSync(errorDir, { recursive: true });
      fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
    }
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  const errorDir = path.join(ipcBaseDir, 'errors');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;

      await processIpcDir(
        path.join(ipcBaseDir, sourceGroup, 'messages'),
        sourceGroup,
        errorDir,
        async (data) => {
          if (data.type !== 'message' || !data.chatJid || !data.text) return;

          const groups = deps.registeredGroups();
          const targetGroup = groups[data.chatJid];
          if (!isMain && (!targetGroup || targetGroup.folder !== sourceGroup)) {
            logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC message attempt blocked');
            return;
          }

          deps.typingManager.stop(data.chatJid);
          const formatted = formatOutbound(data.chatJid, data.text);
          const channel = findChannel(deps.channels, data.chatJid);
          if (channel) {
            await channel.sendMessage(data.chatJid, formatted);
          }
          logger.info({ chatJid: data.chatJid, sourceGroup }, 'IPC message sent');
        },
      );

      await processIpcDir(
        path.join(ipcBaseDir, sourceGroup, 'tasks'),
        sourceGroup,
        errorDir,
        (data) => processTaskIpc(data, sourceGroup, isMain, deps),
      );
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started');
}

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    sessionId?: string;
    taskTitle?: string;
    projectDir?: string;
  },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  switch (data.type) {
    case 'schedule_task':
      if (data.prompt && data.schedule_type && data.schedule_value && data.targetJid) {
        const targetJid = data.targetJid;
        const groups = deps.registeredGroups();
        const targetGroupEntry = groups[targetJid];

        if (!targetGroupEntry) {
          logger.warn({ targetJid }, 'Cannot schedule task: target group not registered');
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn({ sourceGroup, targetFolder }, 'Unauthorized schedule_task attempt blocked');
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, { tz: TIMEZONE });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid cron expression');
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid interval');
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid timestamp');
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info({ taskId, sourceGroup, targetFolder, contextMode }, 'Task created via IPC');
      }
      break;

    case 'pause_task':
    case 'resume_task':
    case 'cancel_task': {
      if (!data.taskId) break;
      const task = getTaskById(data.taskId);
      if (!task || (!isMain && task.group_folder !== sourceGroup)) {
        logger.warn({ taskId: data.taskId, sourceGroup }, `Unauthorized task ${data.type} attempt`);
        break;
      }
      if (data.type === 'cancel_task') {
        deleteTask(data.taskId);
      } else {
        updateTask(data.taskId, { status: data.type === 'pause_task' ? 'paused' : 'active' });
      }
      logger.info({ taskId: data.taskId, sourceGroup }, `Task ${data.type.replace('_task', '')}d via IPC`);
      break;
    }

    case 'refresh_groups':
      if (isMain) {
        logger.info({ sourceGroup }, 'Group metadata refresh requested via IPC');
        await deps.syncGroupMetadata(true);
        const availableGroups = deps.getAvailableGroups();
        const groups = deps.registeredGroups();
        writeGroupsSnapshot(sourceGroup, true, availableGroups, new Set(Object.keys(groups)));
      } else {
        logger.warn({ sourceGroup }, 'Unauthorized refresh_groups attempt blocked');
      }
      break;

    case 'register_group':
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized register_group attempt blocked');
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          requiresTrigger: data.requiresTrigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
        });
      } else {
        logger.warn({ data }, 'Invalid register_group request - missing required fields');
      }
      break;

    case 'register_companion':
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized register_companion attempt blocked');
        break;
      }
      if (data.sessionId && data.taskTitle && data.projectDir && data.chatJid) {
        registerCompanionSession({
          session_id: data.sessionId,
          task_title: data.taskTitle,
          project_dir: data.projectDir,
          chat_jid: data.chatJid,
        });
        logger.info(
          { sessionId: data.sessionId, taskTitle: data.taskTitle, sourceGroup },
          'Companion session registered for monitoring',
        );
      } else {
        logger.warn({ data }, 'Invalid register_companion request - missing required fields');
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
