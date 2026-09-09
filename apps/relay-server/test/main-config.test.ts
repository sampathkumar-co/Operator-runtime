import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { readRelayServiceConfig } from '../src/main.ts';

test('relay service defaults to loopback-only delivery and result binds with bounded separate ports', () => {
  const config = readRelayServiceConfig({});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8788);
  assert.equal(config.resultHost, '127.0.0.1');
  assert.equal(config.resultPort, 8789);
  assert.equal(path.isAbsolute(config.stateDir), true);
});

test('relay service rejects non-loopback bind on either endpoint unless upstream TLS termination is explicitly acknowledged', () => {
  assert.throws(
    () => readRelayServiceConfig({ OPERATOR_RELAY_HOST: '0.0.0.0' }),
    /TLS_TERMINATES_UPSTREAM/
  );
  assert.throws(
    () => readRelayServiceConfig({ OPERATOR_RELAY_RESULT_HOST: '0.0.0.0' }),
    /TLS_TERMINATES_UPSTREAM/
  );
  const accepted = readRelayServiceConfig({
    OPERATOR_RELAY_HOST: '0.0.0.0',
    OPERATOR_RELAY_PORT: '9443',
    OPERATOR_RELAY_RESULT_HOST: '0.0.0.0',
    OPERATOR_RELAY_RESULT_PORT: '9444',
    OPERATOR_RELAY_PUBLIC_BIND_ACK: 'TLS_TERMINATES_UPSTREAM',
    OPERATOR_RELAY_STATE_DIR: './relay-state'
  });
  assert.equal(accepted.host, '0.0.0.0');
  assert.equal(accepted.port, 9443);
  assert.equal(accepted.resultHost, '0.0.0.0');
  assert.equal(accepted.resultPort, 9444);
  assert.equal(path.isAbsolute(accepted.stateDir), true);
});

test('relay service rejects invalid or colliding port configuration', () => {
  for (const value of ['0', '65536', '12.5', 'not-a-port']) {
    assert.throws(() => readRelayServiceConfig({ OPERATOR_RELAY_PORT: value }), /OPERATOR_RELAY_PORT/);
    assert.throws(() => readRelayServiceConfig({ OPERATOR_RELAY_RESULT_PORT: value }), /OPERATOR_RELAY_RESULT_PORT/);
  }
  assert.throws(
    () => readRelayServiceConfig({ OPERATOR_RELAY_PORT: '9000', OPERATOR_RELAY_RESULT_PORT: '9000' }),
    /cannot bind the same host\/port/
  );
});
