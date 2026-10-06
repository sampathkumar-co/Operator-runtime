import fs from 'node:fs/promises';
import type {
  ActionRequest,
  ActionResult,
  CapabilityProvider,
  CapabilityScore
} from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import {
  resolveLspWorkspaceEdit,
  type LspWorkspaceEdit
} from '../core/lsp-workspace-edit.ts';
import { PathScope } from './path-scope.ts';

const SCORE: CapabilityScore = {
  reliability: 0.99,
  latency: 0.78,
  determinism: 0.99,
  security: 0.99,
  reversibility: 1,
  informationQuality: 0.99,
  interactionCost: 0.04
};

export class WorkspaceLspEditProvider implements CapabilityProvider {
  readonly name = 'workspace.edit.lsp.resolve';
  #scope: PathScope;

  constructor(options: {
    allowedRoots: string[];
    windowsPathLeaseExecutable?: string;
  }) {
    this.#scope = new PathScope(options.allowedRoots, {
      windowsPathLeaseExecutable: options.windowsPathLeaseExecutable
    });
  }

  supports(action: ActionRequest): boolean {
    return action.capability === 'workspace.edit.resolve_lsp';
  }

  score(): CapabilityScore {
    return SCORE;
  }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const started = performance.now();
    try {
      if (action.risk !== 'read') {
        throw new OperatorError(
          'LSP_EDIT_RESOLVE_RISK_MISMATCH',
          'workspace.edit.resolve_lsp is read-only and requires read risk.'
        );
      }

      const requestedRoot = String(action.input.workspaceRoot ?? '');
      if (!requestedRoot || requestedRoot.includes('\0')) {
        throw new OperatorError('LSP_EDIT_WORKSPACE_ROOT_REQUIRED', 'workspaceRoot is required.');
      }

      const workspaceRoot = await this.#scope.resolveExisting(requestedRoot);
      const stat = await fs.lstat(workspaceRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new OperatorError(
          'LSP_EDIT_WORKSPACE_ROOT_INVALID',
          'workspaceRoot must resolve to a real authorized directory.'
        );
      }

      const edit = action.input.edit;
      if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
        throw new OperatorError('LSP_EDIT_PAYLOAD_REQUIRED', 'edit must be an LSP WorkspaceEdit object.');
      }

      const expectedDocumentSha256 = action.input.expectedDocumentSha256;
      if (
        !expectedDocumentSha256 ||
        typeof expectedDocumentSha256 !== 'object' ||
        Array.isArray(expectedDocumentSha256)
      ) {
        throw new OperatorError(
          'LSP_EDIT_DIGESTS_REQUIRED',
          'expectedDocumentSha256 must bind every edited document to exact bytes.'
        );
      }

      const trustedCommandIds = action.input.trustedCommandIds === undefined
        ? []
        : action.input.trustedCommandIds;
      if (!Array.isArray(trustedCommandIds)) {
        throw new OperatorError('LSP_EDIT_VERIFICATION_INVALID', 'trustedCommandIds must be an array.');
      }

      const resolved = await resolveLspWorkspaceEdit({
        workspaceRoot,
        edit: edit as LspWorkspaceEdit,
        expectedDocumentSha256: expectedDocumentSha256 as Record<string, string>,
        trustedCommandIds: trustedCommandIds.map((item) => String(item)),
        includeImpactAnalysis: action.input.includeImpactAnalysis !== false
      });

      return {
        ok: true,
        capability: action.capability,
        provider: this.name,
        output: {
          workspaceRoot,
          plan: resolved.plan,
          changedPaths: resolved.changedPaths,
          ...(resolved.impact ? { impact: resolved.impact } : {}),
          mutationPerformed: false
        },
        evidence: [
          evidence(
            'lsp_workspace_edit',
            'pass',
            'Resolved an LSP WorkspaceEdit against exact current document hashes without mutating the workspace.',
            {
              fileCount: resolved.plan.files.length,
              planId: resolved.plan.id,
              impactAnalysis: Boolean(resolved.impact)
            }
          ),
          evidence(
            'lsp_edit_authority_boundary',
            'pass',
            'Resolution produced only an immutable edit plan. Applying it requires a separate authorized workspace.edit.transaction action.',
            { planId: resolved.plan.id }
          )
        ],
        durationMs: Math.round(performance.now() - started)
      };
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError(
          'LSP_EDIT_RESOLVE_FAILED',
          error instanceof Error ? error.message : String(error)
        );
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [
          evidence('lsp_workspace_edit', 'fail', op.message, { code: op.code })
        ],
        error: {
          code: op.code,
          message: op.message,
          retryable: op.retryable,
          sideEffectState: 'none',
          executionPhase: 'pre_dispatch'
        },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }
}
