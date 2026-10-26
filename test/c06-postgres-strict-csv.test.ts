import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCsvObjects } from '../src/capabilities/postgres.ts';

test('C06 PostgreSQL CSV keeps NULL and quoted empty rows with exact distinct semantics', () => {
  const output = parseCsvObjects('value\n\n""\n"hello"\n', 500);
  assert.equal(output.length, 3, 'an unquoted one-column empty data row cannot disappear');
  assert.equal(output[0]!.value, null);
  assert.equal(output[1]!.value, '');
  assert.equal(output[2]!.value, 'hello');
});

test('C06 PostgreSQL CSV preserves commas, quoted newline, double quote and Windows CRLF', () => {
  const rows = parseCsvObjects('name,comment\r\n"hello,world","line 1\r\nline 2"\r\n"A","has ""double"" quote"\r\n', 500);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.name, 'hello,world');
  assert.equal(rows[0]!.comment, 'line 1\r\nline 2');
  assert.equal(rows[1]!.comment, 'has "double" quote');
});

test('C06 malformed PostgreSQL CSV never interprets post-quote data as valid rows', () => {
  for (const csv of [
    'name\n"hello"world\n',
    'name\nhello"world\n',
    'name\n"never-closes\n',
    'name,other\n"one"x,two\n',
    'name,name\na,b\n',
    'a,b\nonlyone\n',
    '\nvalue\n'
  ]) {
    assert.throws(() => parseCsvObjects(csv, 500),
      (error: any) => error?.code === 'POSTGRES_CSV_INVALID', csv);
  }
});

test('C06 rows and byte budgets fail closed rather than reading unbounded CSV', () => {
  assert.throws(() => parseCsvObjects('value\na\nb\n', 1),
    (error: any) => error?.code === 'POSTGRES_ROW_LIMIT_EXCEEDED');
  assert.throws(() => parseCsvObjects('value\n', NaN),
    (error: any) => error?.code === 'POSTGRES_CSV_INVALID');
  assert.throws(() => parseCsvObjects('value\n', 10_000),
    (error: any) => error?.code === 'POSTGRES_CSV_INVALID');
  assert.deepEqual(parseCsvObjects('', 500), []);
  assert.deepEqual(parseCsvObjects('value\n', 500), []);
});

test('C06 PostgreSQL CSV safe null-prototype rows preserve prototype-named column identifiers', () => {
  const result = parseCsvObjects('__proto__,constructor,toString\nhello,world,valid\n', 500);
  assert.equal(result.length, 1);
  assert.equal(Object.getPrototypeOf(result[0]), null);
  assert.deepEqual([result[0]!.__proto__, result[0]!.constructor, result[0]!.toString],
    ['hello', 'world', 'valid']);
});
