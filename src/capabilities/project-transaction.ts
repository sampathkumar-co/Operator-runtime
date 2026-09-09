import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { GitCheckpointProvider } from './git-checkpoint.ts';
import { ProjectCommandProvider } from './project-command.ts';

const SCORE: CapabilityScore = {
  reliability: 0.99,
  latency: 0.88,
  determinism: 0.99,
  security: 0.99,
  reversibility: 0.99,
  informationQuality: 0.99,
  interactionCost: 0.02
};

type RegisteredCommand = {
  id: string;
  risk: 'read' | 'write' | 'external';
};

type RepoState = {
  fingerprint: string;
};

export class ProjectTransactionProvider implements CapabilityProvider {
  readonly name = 'project.transaction.git';
  #commands: ProjectCommandProvider;
  #checkpoints: GitCheckpointProvider;

  constructor(options: { allowedRoots: string[]; allowedExecutables: string[]; registryPath?: string }) {
    this.#commands = new ProjectCommandProvider(options);
    this.#checkpoints = new GitCheckpointProvider({ allowedRoots: options.allowedRoots });
  }

  supports(action: ActionRequest): boolean { return action.capability === 'project.transaction.run'; }
  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const started = performance.now();
    try {
      if (action.risk !== 'destructive') {
        throw new OperatorError('TRANSACTION_DESTRUCTIVE_RISK_REQUIRED', 'Automatic rollback transactions must be authorized as destructive before execution.');
      }
      const projectRoot = String(action.input.path ?? '');
      const commandId = String(action.input.commandId ?? '');
      const expectedRisk = String(action.input.expectedRisk ?? '');
      if (!['read', 'write'].includes(expectedRisk)) {
        throw new OperatorError('TRANSACTION_RISK_UNSUPPORTED', 'Automatic rollback supports only trusted read/write commands; external effects are not reversible.');
      }

      const inspected = await this.#commands.execute({
        id: `${action.id}:inspect-command`,
        capability: 'project.command.inspect',
        risk: 'read',
        input: { path: projectRoot },
        provenance: { kind: 'trusted_policy', source: action.id }
      });
      if (!inspected.ok) throw childError(inspected, 'TRANSACTION_COMMAND_INSPECT_FAILED');
      const command = ((inspected.output as { commands?: RegisteredCommand[] } | undefined)?.commands ?? [])
        .find((candidate) => candidate.id === commandId);
      if (!command) throw new OperatorError('PROJECT_COMMAND_NOT_REGISTERED', `Trusted command ${commandId} is not registered for this project.`);
      if (command.risk === 'external') {
        throw new OperatorError('TRANSACTION_EXTERNAL_UNSUPPORTED', 'External trusted commands cannot run inside automatic rollback transactions.');
      }
      if (command.risk !== expectedRisk) {
        throw new OperatorError('PROJECT_COMMAND_RISK_MISMATCH', 'Transaction expectedRisk must match the trusted registry risk.', {
          details: { expectedRisk, registeredRisk: command.risk }
        });
      }

      const checkpointResult = await this.#checkpoints.execute({
        id: `${action.id}:checkpoint`,
        capability: 'git.checkpoint.create',
        risk: 'write',
        input: { cwd: projectRoot, label: `transaction before ${commandId}` },
        provenance: { kind: 'trusted_policy', source: action.id }
      });
      if (!checkpointResult.ok) throw childError(checkpointResult, 'TRANSACTION_CHECKPOINT_FAILED');
      const checkpoint = checkpointResult.output as { id: string; fingerprint: string };

      const commandResult = await this.#commands.execute({
        id: `${action.id}:command`,
        capability: 'project.command.run',
        risk: command.risk,
        input: { path: projectRoot, commandId, expectedRisk: command.risk },
        provenance: { kind: 'trusted_policy', source: action.id }
      });

      if (commandResult.ok) {
        return {
          ok: true,
          capability: action.capability,
          provider: this.name,
          output: {
            commandId,
            commandRisk: command.risk,
            checkpointId: checkpoint.id,
            checkpointFingerprint: checkpoint.fingerprint,
            rollbackPerformed: false,
            rollbackCoverage: 'Git index + non-ignored working-tree state captured by git.checkpoint',
            command: commandResult
          },
          evidence: [
            evidence('transaction_checkpoint', 'pass', 'Created a non-mutating Git checkpoint before the trusted command.', { checkpointId: checkpoint.id }),
            evidence('transaction_command', 'pass', 'Trusted command and declared postconditions verified; rollback was not required.', { commandId }),
            evidence('recovery_checkpoint', 'info', 'Pre-command checkpoint remains available for explicit recovery.', { checkpointId: checkpoint.id })
          ],
          durationMs: Math.round(performance.now() - started)
        };
      }

      const currentResult = await this.#checkpoints.execute({
        id: `${action.id}:inspect-after-failure`,
        capability: 'git.checkpoint.inspect',
        risk: 'read',
        input: { cwd: projectRoot },
        provenance: { kind: 'trusted_policy', source: action.id }
      });
      if (!currentResult.ok) {
        return rollbackFailure(action, started, checkpoint.id, commandResult, currentResult, 'Unable to inspect repository state before rollback.');
      }
      const current = (currentResult.output as { current?: RepoState } | undefined)?.current;
      if (!current?.fingerprint) {
        return rollbackFailure(action, started, checkpoint.id, commandResult, currentResult, 'Repository fingerprint was unavailable before rollback.');
      }

      const restoreResult = await this.#checkpoints.execute({
        id: `${action.id}:rollback`,
        capability: 'git.checkpoint.restore',
        risk: 'destructive',
        input: {
          cwd: projectRoot,
          checkpointId: checkpoint.id,
          expectedCurrentFingerprint: current.fingerprint
        },
        provenance: { kind: 'trusted_policy', source: action.id }
      });

      if (!restoreResult.ok) {
        return rollbackFailure(action, started, checkpoint.id, commandResult, restoreResult, 'Trusted command failed and automatic Git rollback could not be verified.');
      }

      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        output: {
          commandId,
          commandRisk: command.risk,
          checkpointId: checkpoint.id,
          rollbackPerformed: true,
          rollbackCoverage: 'Git index + non-ignored working-tree state captured by git.checkpoint',
          command: commandResult,
          rollback: restoreResult
        },
        evidence: [
          evidence('transaction_checkpoint', 'pass', 'Created a non-mutating Git checkpoint before the trusted command.', { checkpointId: checkpoint.id }),
          evidence('transaction_command', 'fail', commandResult.error?.message ?? 'Trusted command verification failed.', { commandId, code: commandResult.error?.code }),
          evidence('transaction_rollback', 'pass', 'Trusted command failed; Git checkpoint restore completed and verified.', { checkpointId: checkpoint.id })
        ],
        error: {
          code: 'TRANSACTION_FAILED_ROLLED_BACK',
          message: `Trusted command ${commandId} failed verification and repository state was rolled back to the pre-command checkpoint.`,
          retryable: true
        },
        durationMs: Math.round(performance.now() - started)
      };
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError('PROJECT_TRANSACTION_ERROR', error instanceof Error ? error.message : String(error));
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [evidence('project_transaction', 'fail', op.message, { code: op.code })],
        error: { code: op.code, message: op.message, retryable: op.retryable },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }
}

function childError(result: ActionResult, fallbackCode: string): OperatorError {
  return new OperatorError(result.error?.code ?? fallbackCode, result.error?.message ?? fallbackCode, { retryable: result.error?.retryable });
}

function rollbackFailure(
  action: ActionRequest,
  started: number,
  checkpointId: string,
  commandResult: ActionResult,
  rollbackResult: ActionResult,
  message: string
): ActionResult {
  return {
    ok: false,
    capability: action.capability,
    provider: 'project.transaction.git',
    output: {
      checkpointId,
      rollbackPerformed: false,
      rollbackCoverage: 'Git index + non-ignored working-tree state captured by git.checkpoint',
      command: commandResult,
      rollbackAttempt: rollbackResult
    },
    evidence: [
      evidence('transaction_command', 'fail', commandResult.error?.message ?? 'Trusted command verification failed.', { code: commandResult.error?.code }),
      evidence('transaction_rollback', 'fail', message, { checkpointId, code: rollbackResult.error?.code })
    ],
    error: { code: 'TRANSACTION_FAILED_ROLLBACK_FAILED', message, retryable: false },
    durationMs: Math.round(performance.now() - started)
  };
}
