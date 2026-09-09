import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { TaskCapsule } from './task.ts';
import { OperatorError } from './errors.ts';

export class TaskStore {
  #dir: string;

  constructor(stateDir: string) {
    this.#dir = path.join(path.resolve(stateDir), 'tasks');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.#dir, { recursive: true, mode: 0o700 });
  }

  async put(task: TaskCapsule): Promise<void> {
    await this.init();
    const file = this.#file(task.id);
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(task, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, file);
  }

  async get(taskId: string): Promise<TaskCapsule> {
    await this.init();
    try {
      const parsed = JSON.parse(await fs.readFile(this.#file(taskId), 'utf8')) as TaskCapsule;
      if (parsed.id !== taskId) throw new Error('task id mismatch');
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new OperatorError('TASK_NOT_FOUND', `Task ${taskId} was not found.`);
      }
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('TASK_STATE_CORRUPT', `Stored task ${taskId} could not be read.`, { details: { cause: String(error) } });
    }
  }

  async list(limit = 100): Promise<Array<Pick<TaskCapsule, 'id' | 'userObjective' | 'state' | 'updatedAt'>>> {
    await this.init();
    const entries = (await fs.readdir(this.#dir)).filter((name) => name.endsWith('.json')).slice(0, Math.max(1, Math.min(limit, 500)));
    const tasks = await Promise.all(entries.map(async (name) => {
      try { return JSON.parse(await fs.readFile(path.join(this.#dir, name), 'utf8')) as TaskCapsule; } catch { return null; }
    }));
    return tasks
      .filter((task): task is TaskCapsule => task !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ id, userObjective, state, updatedAt }) => ({ id, userObjective, state, updatedAt }));
  }

  async delete(taskId: string): Promise<void> {
    await this.init();
    await fs.rm(this.#file(taskId), { force: true });
  }

  #file(taskId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw new OperatorError('INVALID_TASK_ID', 'Invalid task id.');
    return path.join(this.#dir, `${taskId}.json`);
  }
}
