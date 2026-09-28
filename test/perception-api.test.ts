import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OperatorRuntime } from '../src/core/runtime.ts';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../src/core/types.ts';
import { PerceptionGraphStore } from '../src/core/perception-graph.ts';
import { PerceptionProvider } from '../src/capabilities/perception.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

const SCORE: CapabilityScore = {
  reliability: 1, latency: 0, determinism: 1, security: 1,
  reversibility: 1, informationQuality: 1, interactionCost: 0
};

class UiaProbe implements CapabilityProvider {
  readonly name = 'windows.uia.test';
  supports(action: ActionRequest): boolean { return action.capability === 'app.inspect'; }
  score(): CapabilityScore { return SCORE; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    return {
      ok: true,
      capability: action.capability,
      provider: this.name,
      output: {
        elements: [{
          name: 'Export',
          automation_id: 'export-button',
          class_name: 'Button',
          control_type: 'Button',
          process_id: 777,
          depth: 1,
          bounds: { x: 300, y: 120, width: 100, height: 40 },
          patterns: { invoke: true }
        }]
      },
      evidence: [],
      durationMs: 1
    };
  }
}

test('stage11 local execute boundary auto-publishes UIA geometry for governed grounding', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-perception-api-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));

  const graph = new PerceptionGraphStore(state);
  const runtime = new OperatorRuntime()
    .register(new UiaProbe())
    .register(new PerceptionProvider(graph));
  const token = 'p'.repeat(64);
  const agent = createLocalAgentServer({
    runtime,
    token,
    perception: graph,
    permissions: {
      allowedCapabilities: ['app.inspect', 'perception.ground'],
      allowedRoots: []
    }
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${bound.port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const inspected = await fetch(`${base}/v1/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: {
        id: 'inspect-export',
        capability: 'app.inspect',
        risk: 'read',
        input: { selector: { automationId: 'export-button' } },
        provenance: { kind: 'chatgpt' }
      }
    })
  });
  assert.equal(inspected.status, 200);

  const scene = await graph.scene('uia:process:777');
  assert.equal(scene.length, 1);
  assert.deepEqual(scene[0]!.bounds, { x: 300, y: 120, width: 100, height: 40 });

  const groundedResponse = await fetch(`${base}/v1/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: {
        id: 'ground-export',
        capability: 'perception.ground',
        risk: 'read',
        input: { sceneKey: 'uia:process:777', role: 'Button', name: 'Export' },
        provenance: { kind: 'chatgpt' }
      }
    })
  });
  assert.equal(groundedResponse.status, 200);
  const grounded = await groundedResponse.json() as any;
  assert.deepEqual(grounded.output.center, { x: 350, y: 140 });
});
