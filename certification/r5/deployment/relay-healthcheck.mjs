const checks = [
  ['relay', Number(process.env.OPERATOR_RELAY_PORT ?? 8788)],
  ['result', Number(process.env.OPERATOR_RELAY_RESULT_PORT ?? 8789)]
];

for (const [service, port] of checks) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`${service} health returned HTTP ${response.status}`);
  const body = await response.json();
  if (body?.ok !== true) throw new Error(`${service} health was not ready`);
  if (service === 'relay' && body.clustered !== true) throw new Error('relay is not using the shared cluster control plane');
}
