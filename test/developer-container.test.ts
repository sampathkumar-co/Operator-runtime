import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  DeveloperContainerManager,
  type DeveloperDockerResult,
  type DeveloperDockerRunner
} from '../src/core/developer-container.ts';
import { DeveloperWorktreeManager } from '../src/core/developer-worktree.ts';
import { resolveSupportedGitExecutable } from '../src/core/trusted-executable.ts';
import { supportedGitAvailable } from './git-test-support.ts';

const IMAGE = 'example/dev@sha256:' + '1'.repeat(64);
const CONTAINER_ID = 'a'.repeat(64);

type FakeContainer = {
  id: string;
  name: string;
  label: string;
  image: string;
  worktreePath: string;
  state: 'created' | 'running' | 'exited';
  pidsLimit: number;
  memoryMb: number;
  cpu: number;
};

class FakeDocker {
  container?: FakeContainer;
  createArgs?: string[];
  failAfterCreate = false;
  remote = false;

  runner: DeveloperDockerRunner = async (args): Promise<DeveloperDockerResult> => {
    if (args[0] === 'context' && args[1] === 'show') {
      return { code: 0, stdout: 'default\n', stderr: '' };
    }
    if (args[0] === 'context' && args[1] === 'inspect') {
      return {
        code: 0,
        stdout: JSON.stringify(this.remote ? 'tcp://10.0.0.7:2375' : 'unix:///var/run/docker.sock') + '\n',
        stderr: ''
      };
    }

    assert.equal(args[0], '--context');
    assert.equal(args[1], 'default');
    const docker = args.slice(2);

    if (docker[0] === 'create') {
      this.createArgs = [...docker];
      const name = valueAfter(docker, '--name');
      const label = valueAfter(docker, '--label');
      const mount = valueAfter(docker, '--mount');
      const pidsLimit = Number(valueAfter(docker, '--pids-limit'));
      const memory = valueAfter(docker, '--memory');
      const cpu = Number(valueAfter(docker, '--cpus'));
      const image = docker.find((item) => item.includes('@sha256:'));
      assert.ok(image);
      const source = /(?:^|,)src=([^,]+)(?:,|$)/.exec(mount)?.[1];
      assert.ok(source);
      this.container = {
        id: CONTAINER_ID,
        name,
        label,
        image,
        worktreePath: source,
        state: 'created',
        pidsLimit,
        memoryMb: Number(memory.replace(/m$/i, '')),
        cpu
      };
      if (this.failAfterCreate) {
        throw new Error('simulated runner crash after docker create side effect');
      }
      return { code: 0, stdout: CONTAINER_ID + '\n', stderr: '' };
    }

    if (docker[0] === 'ps') {
      if (!this.container) return { code: 0, stdout: '', stderr: '' };
      const filters = docker
        .map((item, index) => item === '--filter' ? docker[index + 1] : undefined)
        .filter(Boolean);
      const labelOk = filters.some((item) => item === 'label=' + this.container!.label);
      const nameOk = filters.some((item) => item === 'name=^/' + this.container!.name + '$');
      return {
        code: 0,
        stdout: labelOk && nameOk ? this.container.id.slice(0, 12) + '\n' : '',
        stderr: ''
      };
    }

    if (docker[0] === 'inspect' && docker[1] === '--format') {
      if (!this.container || !this.container.id.startsWith(String(docker[3] ?? ''))) {
        return { code: 1, stdout: '', stderr: 'Error: No such container' };
      }
      return { code: 0, stdout: this.container.id + '\n', stderr: '' };
    }

    if (docker[0] === 'inspect') {
      const id = String(docker[1] ?? '');
      if (!this.container || !this.container.id.startsWith(id)) {
        return { code: 1, stdout: '', stderr: 'Error: No such container: ' + id };
      }
      return {
        code: 0,
        stdout: JSON.stringify([{
          Id: this.container.id,
          Name: '/' + this.container.name,
          Config: {
            Image: this.container.image,
            Labels: {
              'io.mecord.developer-container': this.container.label.split('=')[1]
            }
          },
          State: { Status: this.container.state },
          HostConfig: {
            NetworkMode: 'none',
            ReadonlyRootfs: true,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges'],
            PidsLimit: this.container.pidsLimit,
            Memory: this.container.memoryMb * 1024 * 1024,
            NanoCpus: Math.round(this.container.cpu * 1_000_000_000)
          },
          Mounts: [{
            Type: 'bind',
            Source: this.container.worktreePath,
            Destination: '/workspace',
            RW: true
          }]
        }]),
        stderr: ''
      };
    }

    if (docker[0] === 'start') {
      if (!this.container || this.container.id !== docker[1]) {
        return { code: 1, stdout: '', stderr: 'No such container' };
      }
      this.container.state = 'running';
      return { code: 0, stdout: this.container.id + '\n', stderr: '' };
    }

    if (docker[0] === 'rm' && docker[1] === '--force') {
      if (!this.container || this.container.id !== docker[2]) {
        return { code: 1, stdout: '', stderr: 'No such container' };
      }
      const id = this.container.id;
      this.container = undefined;
      return { code: 0, stdout: id + '\n', stderr: '' };
    }

    throw new Error('Unexpected fake Docker args: ' + JSON.stringify(args));
  };
}

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  assert.ok(index >= 0, 'missing flag ' + flag);
  const value = args[index + 1];
  assert.ok(value, 'missing value for ' + flag);
  return value;
}

async function gitFixture(t: TestContext) {
  if (!supportedGitAvailable()) {
    t.skip('supported Git unavailable');
    return undefined;
  }
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-dev-container-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const repo = path.join(parent, 'repo');
  const worktreeRoot = path.join(parent, 'worktrees');
  const stateDir = path.join(parent, 'state');
  await fs.mkdir(repo);
  const git = resolveSupportedGitExecutable(process.env);
  const run = (args: string[]) => {
    const result = spawnSync(git, args, {
      cwd: repo,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        SYSTEMROOT: process.env.SYSTEMROOT,
        WINDIR: process.env.WINDIR,
        GIT_CONFIG_NOSYSTEM: '1'
      }
    });
    assert.equal(result.status, 0, String(result.stderr));
    return String(result.stdout).trim();
  };
  run(['init']);
  run(['config', 'user.email', 'tests@example.invalid']);
  run(['config', 'user.name', 'Mecord Tests']);
  await fs.writeFile(path.join(repo, 'package.json'), '{"name":"fixture"}\n');
  run(['add', '--', 'package.json']);
  run(['commit', '-m', 'base']);
  const commit = run(['rev-parse', 'HEAD']);

  const sessionId = 'container-session-1';
  const worktrees = new DeveloperWorktreeManager({
    allowedRepositoryRoots: [repo],
    worktreeRoot,
    stateDir
  });
  const worktree = await worktrees.create({
    sessionId,
    repositoryRoot: repo,
    baseCommit: commit
  });
  assert.ok(worktree.fingerprint);
  return {
    parent,
    repo,
    worktreeRoot,
    stateDir,
    sessionId,
    worktree,
    input: {
      sessionId,
      expectedWorktreeFingerprint: worktree.fingerprint!,
      image: IMAGE,
      command: ['node', '-e', 'setInterval(() => {}, 1000)'],
      memoryMb: 512,
      cpu: 1.5,
      pidsLimit: 128
    }
  };
}

test('Developer container is created with hardened isolation, reconciled, and released by exact fingerprint', async (t) => {
  const fx = await gitFixture(t);
  if (!fx) return;
  const docker = new FakeDocker();
  const manager = new DeveloperContainerManager({
    allowedRepositoryRoots: [fx.repo],
    worktreeRoot: fx.worktreeRoot,
    stateDir: fx.stateDir,
    runner: docker.runner
  });

  const created = await manager.create(fx.input);
  assert.equal(created.record.phase, 'ACTIVE');
  assert.equal(created.state, 'running');
  assert.ok(created.fingerprint);
  assert.ok(docker.createArgs);
  const args = docker.createArgs!;
  assert.deepEqual(args.slice(0, 3), ['create', '--pull', 'never']);
  assert.equal(valueAfter(args, '--network'), 'none');
  assert.ok(args.includes('--read-only'));
  assert.equal(valueAfter(args, '--cap-drop'), 'ALL');
  assert.equal(valueAfter(args, '--security-opt'), 'no-new-privileges');
  assert.equal(valueAfter(args, '--pids-limit'), '128');
  assert.equal(valueAfter(args, '--memory'), '512m');
  assert.equal(valueAfter(args, '--cpus'), '1.5');
  assert.equal(valueAfter(args, '--workdir'), '/workspace');
  assert.match(valueAfter(args, '--mount'), /^type=bind,src=.+,dst=\/workspace$/);
  assert.equal(args.includes('--env'), false);
  assert.equal(args.includes('-e'), true, 'container command may legitimately include -e argv');

  const inspected = await manager.inspect(fx.sessionId);
  assert.equal(inspected.record.phase, 'ACTIVE');
  assert.equal(inspected.fingerprint, created.fingerprint);

  const released = await manager.release({
    sessionId: fx.sessionId,
    expectedContainerFingerprint: created.fingerprint!
  });
  assert.equal(released.record.phase, 'RELEASED');
  assert.equal(released.exists, false);
  assert.equal(docker.container, undefined);
});

test('crash after docker create is recovered from ownership label without duplicate container', async (t) => {
  const fx = await gitFixture(t);
  if (!fx) return;
  const docker = new FakeDocker();
  docker.failAfterCreate = true;
  const first = new DeveloperContainerManager({
    allowedRepositoryRoots: [fx.repo],
    worktreeRoot: fx.worktreeRoot,
    stateDir: fx.stateDir,
    runner: docker.runner
  });

  await assert.rejects(() => first.create(fx.input), /simulated runner crash/);
  assert.ok(docker.container);
  assert.equal(docker.container?.state, 'created');

  docker.failAfterCreate = false;
  const restarted = new DeveloperContainerManager({
    allowedRepositoryRoots: [fx.repo],
    worktreeRoot: fx.worktreeRoot,
    stateDir: fx.stateDir,
    runner: docker.runner
  });
  const recovered = await restarted.create(fx.input);
  assert.equal(recovered.record.phase, 'ACTIVE');
  assert.equal(recovered.record.containerId, CONTAINER_ID);
  assert.equal(docker.container?.state, 'running');
});

test('remote Docker context is denied before container creation', async (t) => {
  const fx = await gitFixture(t);
  if (!fx) return;
  const docker = new FakeDocker();
  docker.remote = true;
  const manager = new DeveloperContainerManager({
    allowedRepositoryRoots: [fx.repo],
    worktreeRoot: fx.worktreeRoot,
    stateDir: fx.stateDir,
    runner: docker.runner
  });
  await assert.rejects(
    () => manager.create(fx.input),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_CONTAINER_REMOTE_DOCKER_DENIED');
      return true;
    }
  );
  assert.equal(docker.container, undefined);
});

test('unpinned image and stale worktree fingerprints fail before Docker mutation', async (t) => {
  const fx = await gitFixture(t);
  if (!fx) return;
  const docker = new FakeDocker();
  const manager = new DeveloperContainerManager({
    allowedRepositoryRoots: [fx.repo],
    worktreeRoot: fx.worktreeRoot,
    stateDir: fx.stateDir,
    runner: docker.runner
  });

  await assert.rejects(
    () => manager.create({ ...fx.input, image: 'node:22-alpine' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_CONTAINER_IMAGE_UNPINNED');
      return true;
    }
  );
  await assert.rejects(
    () => manager.create({ ...fx.input, expectedWorktreeFingerprint: 'f'.repeat(64) }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_CONTAINER_WORKTREE_PRECONDITION_FAILED');
      return true;
    }
  );
  assert.equal(docker.container, undefined);
});

test('durable Developer container record tampering is detected before reuse', async (t) => {
  const fx = await gitFixture(t);
  if (!fx) return;
  const docker = new FakeDocker();
  const manager = new DeveloperContainerManager({
    allowedRepositoryRoots: [fx.repo],
    worktreeRoot: fx.worktreeRoot,
    stateDir: fx.stateDir,
    runner: docker.runner
  });
  await manager.create(fx.input);

  const recordPath = path.join(
    fx.stateDir,
    'developer-containers',
    fx.sessionId + '.json'
  );
  const raw = JSON.parse(await fs.readFile(recordPath, 'utf8')) as { memoryMb: number };
  raw.memoryMb = 4096;
  await fs.writeFile(recordPath, JSON.stringify(raw, null, 2));

  await assert.rejects(
    () => manager.inspect(fx.sessionId),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_CONTAINER_STATE_CORRUPT');
      return true;
    }
  );
});

test('release requires a fresh container fingerprint', async (t) => {
  const fx = await gitFixture(t);
  if (!fx) return;
  const docker = new FakeDocker();
  const manager = new DeveloperContainerManager({
    allowedRepositoryRoots: [fx.repo],
    worktreeRoot: fx.worktreeRoot,
    stateDir: fx.stateDir,
    runner: docker.runner
  });
  await manager.create(fx.input);

  await assert.rejects(
    () => manager.release({
      sessionId: fx.sessionId,
      expectedContainerFingerprint: 'e'.repeat(64)
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_CONTAINER_STATE_CHANGED');
      return true;
    }
  );
  assert.ok(docker.container);
});
