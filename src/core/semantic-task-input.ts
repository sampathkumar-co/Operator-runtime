export interface PostgresSelectGoalInput {
  root: string;
  profileId: string;
  schema?: string;
  table: string;
  columns?: readonly string[];
  filters?: readonly unknown[];
  orderBy?: readonly unknown[];
  limit?: number;
  offset?: number;
  timeoutMs?: number;
}

export function postgresSelectActionInput(goal: PostgresSelectGoalInput): Record<string, unknown> {
  return {
    path: goal.root,
    profileId: goal.profileId,
    schema: goal.schema ?? 'public',
    table: goal.table,
    columns: goal.columns ?? [],
    filters: goal.filters ?? [],
    orderBy: goal.orderBy ?? [],
    limit: goal.limit ?? 100,
    offset: goal.offset ?? 0,
    timeoutMs: goal.timeoutMs ?? 5_000
  };
}
