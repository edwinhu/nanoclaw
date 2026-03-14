import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getTaskById,
  registerCompanionSession,
  updateTask,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

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
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

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

    const registeredGroups = deps.registeredGroups();

    // Build folder->isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;

      await processIpcDir(
        path.join(ipcBaseDir, sourceGroup, 'messages'),
        sourceGroup,
        errorDir,
        async (data) => {
          if (data.type !== 'message' || !data.chatJid || !data.text) return;

          const targetGroup = registeredGroups[data.chatJid];
          if (!isMain && (!targetGroup || targetGroup.folder !== sourceGroup)) {
            logger.warn(
              { chatJid: data.chatJid, sourceGroup },
              'Unauthorized IPC message attempt blocked',
            );
            return;
          }

          await deps.sendMessage(data.chatJid, data.text);
          logger.info(
            { chatJid: data.chatJid, sourceGroup },
            'IPC message sent',
          );
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

export async function processTaskIpc(
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
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    sessionId?: string;
    taskTitle?: string;
    projectDir?: string;
    requestId?: string;
    sessionName?: string;
    timeout?: number;
    resume?: string;
    extra?: string;
    command?: string;
    paneId?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
    case 'resume_task':
    case 'cancel_task': {
      if (!data.taskId) break;
      const task = getTaskById(data.taskId);
      if (!task || (!isMain && task.group_folder !== sourceGroup)) {
        logger.warn(
          { taskId: data.taskId, sourceGroup },
          `Unauthorized task ${data.type} attempt`,
        );
        break;
      }
      if (data.type === 'cancel_task') {
        deleteTask(data.taskId);
      } else {
        updateTask(data.taskId, {
          status: data.type === 'pause_task' ? 'paused' : 'active',
        });
      }
      logger.info(
        { taskId: data.taskId, sourceGroup },
        `Task ${data.type.replace('_task', '')}d via IPC`,
      );
      break;
    }

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'launch_remote_session': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized launch_remote_session attempt blocked',
        );
        break;
      }
      if (!data.requestId || !data.projectDir) {
        logger.warn(
          { data },
          'Invalid launch_remote_session request - missing fields',
        );
        break;
      }

      const resultsDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'results');
      fs.mkdirSync(resultsDir, { recursive: true });
      const resultFile = path.join(resultsDir, `${data.requestId}.json`);

      try {
        const launchScript = path.join(
          process.env.HOME || '/Users/vwh7mb',
          '.claude/skills/remote-session/scripts/launch-remote.sh',
        );
        const args = [`--project-dir`, data.projectDir];
        if (data.sessionName) args.push(`--name`, data.sessionName);
        if (data.timeout) args.push(`--timeout`, String(data.timeout));
        if (data.resume) args.push(`--resume`, data.resume);
        if (data.extra) args.push(`--extra`, data.extra);

        const cmd = ['bash', launchScript, ...args]
          .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
          .join(' ');

        // execSync throws on non-zero exit, but the script outputs JSON even on
        // failure. Catch and extract stdout from the error object.
        let output: string;
        try {
          output = execSync(cmd, {
            timeout: 120_000,
            encoding: 'utf-8',
            env: {
              ...process.env,
              CLAUDECODE: '',
              PATH: `${process.env.HOME}/.nix-profile/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
            },
          }).trim();
        } catch (execErr: any) {
          // Script exited non-zero but may have printed JSON to stdout
          output = (execErr.stdout || '').toString().trim();
          if (!output) {
            throw execErr;
          }
        }

        const result = JSON.parse(output);
        fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
        if (result.status === 'error') {
          logger.error(
            { requestId: data.requestId, result },
            'Remote session launch returned error',
          );
        } else {
          logger.info(
            { requestId: data.requestId, result },
            'Remote session launched via IPC',
          );
        }
      } catch (err) {
        const errorResult = {
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        };
        fs.writeFileSync(resultFile, JSON.stringify(errorResult, null, 2));
        logger.error(
          { requestId: data.requestId, err },
          'Failed to launch remote session',
        );
      }
      break;
    }

    case 'send_session_command': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized send_session_command attempt blocked',
        );
        break;
      }
      if (!data.requestId || !data.command) {
        logger.warn(
          { data },
          'Invalid send_session_command request - missing fields',
        );
        break;
      }

      const scResultsDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'results');
      fs.mkdirSync(scResultsDir, { recursive: true });
      const scResultFile = path.join(scResultsDir, `${data.requestId}.json`);

      try {
        const sendScript = path.join(
          process.env.HOME || '/Users/vwh7mb',
          '.claude/skills/remote-session/scripts/send-command.sh',
        );
        const args = [data.command];
        if (data.paneId) args.unshift('--pane-id', data.paneId);

        const cmd = ['bash', sendScript, ...args]
          .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
          .join(' ');

        let output: string;
        try {
          output = execSync(cmd, {
            timeout: 15_000,
            encoding: 'utf-8',
            env: {
              ...process.env,
              PATH: `${process.env.HOME}/.nix-profile/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
            },
          }).trim();
        } catch (execErr: any) {
          output = (execErr.stdout || '').toString().trim();
          if (!output) throw execErr;
        }

        const result = JSON.parse(output);
        fs.writeFileSync(scResultFile, JSON.stringify(result, null, 2));
        logger.info(
          { requestId: data.requestId, result },
          'Session command sent via IPC',
        );
      } catch (err) {
        const errorResult = {
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        };
        fs.writeFileSync(scResultFile, JSON.stringify(errorResult, null, 2));
        logger.error(
          { requestId: data.requestId, err },
          'Failed to send session command',
        );
      }
      break;
    }

    case 'register_companion':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_companion attempt blocked',
        );
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
          {
            sessionId: data.sessionId,
            taskTitle: data.taskTitle,
            sourceGroup,
          },
          'Companion session registered for monitoring',
        );
      } else {
        logger.warn(
          { data },
          'Invalid register_companion request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
