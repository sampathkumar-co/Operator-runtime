import http from 'node:http';

export async function loopbackHttpStatus(urlInput, options = {}) {
  const url = new URL(urlInput);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('Health probes must target credential-free http://127.0.0.1 URLs.');
  }
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
    throw new Error('Health probe timeout must be between 100 and 10000 ms.');
  }

  return await new Promise((resolve, reject) => {
    const request = http.get(url, { headers: options.headers ?? {}, timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once('timeout', () => request.destroy(new Error('health probe timed out')));
    request.once('error', reject);
  });
}
