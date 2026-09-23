import { createInterface } from 'node:readline';

export function parseApprovalConsoleCommand(input) {
  const parts = String(input ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const verb = parts[0].toLowerCase();
  if (verb === 'approvals' && parts.length === 1) return { kind: 'list' };
  if (verb === 'help' && parts.length === 1) return { kind: 'help' };
  const sessionVerb = verb === 'session' || verb === 'allow-session' || verb === 'approve-session';
  if ((verb === 'approve' || verb === 'deny' || sessionVerb) && parts.length <= 2) {
    return { kind: 'decision', decision: sessionVerb ? 'session' : verb, selector: parts[1]?.toLowerCase() };
  }
  return { kind: 'invalid' };
}

export function validateLocalAgentReadyMessage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.type !== 'mecord-local-agent-ready' || input.host !== '127.0.0.1') return null;
  const port = Number(input.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
  return { baseUrl: `http://127.0.0.1:${port}` };
}

function displayTarget(value) {
  const text = String(value ?? '').replace(/[\r\n\t]/g, ' ').trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function matchPendingApproval(pending, selector) {
  if (!selector) return pending.length === 1 ? pending[0] : null;
  const needle = selector.toLowerCase();
  const matches = pending.filter((record) =>
    String(record.actionId).toLowerCase().startsWith(needle)
    || String(record.approvalRequestId).toLowerCase().startsWith(needle)
  );
  return matches.length === 1 ? matches[0] : null;
}

function writeApprovalList(output, pending) {
  if (pending.length === 0) {
    output.write('[mecord-connect] no pending approvals.\n');
    return;
  }
  output.write(`[mecord-connect] pending approvals (${pending.length}):\n`);
  for (const record of pending) {
    output.write(`  ${String(record.actionId).slice(0, 12)}  ${record.capability}  ${record.risk}  ${displayTarget(record.target)}\n`);
  }
  output.write(pending.length === 1
    ? '[mecord-connect] choose: "approve" (once), "session" (allow this runtime session), or "deny".\n'
    : '[mecord-connect] choose "approve <id-prefix>", "session <id-prefix>", or "deny <id-prefix>".\n');
}

async function localAgentJson(baseUrl, agentToken, { pathName, method = 'GET', recoveryToken, body } = {}) {
  const headers = {
    authorization: `Bearer ${agentToken}`,
    accept: 'application/json'
  };
  if (recoveryToken) headers['x-operator-recovery-token'] = recoveryToken;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000)
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* fail closed below */ }
  if (!response.ok || payload?.ok === false) {
    const code = payload?.error?.code ? ` (${payload.error.code})` : '';
    throw new Error(`local approval request failed${code}`);
  }
  return payload;
}

export function startLocalApprovalConsole({
  baseUrl,
  agentToken,
  recoveryToken,
  input = process.stdin,
  output = process.stdout
}) {
  let stopped = false;
  let pending = [];
  let busy = false;
  const announced = new Set();
  const interactive = Boolean(input?.isTTY);

  const refresh = async (announce = false) => {
    if (stopped || busy) return pending;
    busy = true;
    try {
      const payload = await localAgentJson(baseUrl, agentToken, { pathName: '/v1/approvals' });
      pending = Array.isArray(payload?.approvals)
        ? payload.approvals.filter((record) => record?.status === 'pending')
        : [];
      if (announce) {
        for (const record of pending) {
          if (announced.has(record.approvalRequestId)) continue;
          announced.add(record.approvalRequestId);
          output.write(`\n[mecord-connect] approval required: ${record.capability} (${record.risk}) ${displayTarget(record.target)}\n`);
          output.write(pending.length === 1
            ? '[mecord-connect] choose "approve" once, "session" for this runtime session, or "deny".\n'
            : `[mecord-connect] choose "approve ${String(record.actionId).slice(0, 12)}", "session ${String(record.actionId).slice(0, 12)}", or "deny ${String(record.actionId).slice(0, 12)}".\n`);
        }
      }
      return pending;
    } catch {
      return pending;
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => { void refresh(true); }, 1000);
  timer.unref?.();

  let rl = null;
  if (interactive) {
    rl = createInterface({ input, output, terminal: true });
    output.write('[mecord-connect] local approval console ready. Type "approvals" to list pending actions.\n');
    rl.on('line', (line) => {
      void (async () => {
        const command = parseApprovalConsoleCommand(line);
        if (!command) return;
        if (command.kind === 'help') {
          output.write('[mecord-connect] commands: approvals | approve [id-prefix] | session [id-prefix] | deny [id-prefix]\n');
          return;
        }
        if (command.kind === 'invalid') {
          output.write('[mecord-connect] unknown approval command. Type "help".\n');
          return;
        }
        const current = await refresh(false);
        if (command.kind === 'list') {
          writeApprovalList(output, current);
          return;
        }
        const record = matchPendingApproval(current, command.selector);
        if (!record) {
          if (current.length === 0) output.write('[mecord-connect] no pending approval matches that request.\n');
          else writeApprovalList(output, current);
          return;
        }
        try {
          const payload = await localAgentJson(baseUrl, agentToken, {
            pathName: `/v1/approvals/${encodeURIComponent(record.actionId)}`,
            method: 'POST',
            recoveryToken,
            body: {
              decision: command.decision,
              approvalRequestId: record.approvalRequestId
            }
          });
          const status = payload?.approval?.status ?? command.decision;
          output.write(`[mecord-connect] ${status}: ${record.capability} ${displayTarget(record.target)}\n`);
          if (command.decision === 'approve') {
            output.write('[mecord-connect] approved once for this exact action. Retry the same ChatGPT request within 10 minutes.\n');
          } else if (command.decision === 'session') {
            const expiresAt = payload?.session?.expiresAt;
            const idleExpiresAt = payload?.session?.idleExpiresAt;
            output.write(`[mecord-connect] session access enabled for this account/device/root${expiresAt ? ` until ${expiresAt}` : ''}${idleExpiresAt ? ` (idle expiry ${idleExpiresAt})` : ''}.\n`);
            output.write('[mecord-connect] external, system, and destructive actions inside the current authorized scope will not re-prompt during this session.\n');
          }
          announced.delete(record.approvalRequestId);
          await refresh(false);
        } catch (error) {
          output.write(`[mecord-connect] approval update failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
        }
      })();
    });
  }

  void refresh(true);

  return () => {
    stopped = true;
    clearInterval(timer);
    try { rl?.close(); } catch { /* noop */ }
  };
}
