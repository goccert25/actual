import { beforeEach, describe, expect, it, vi } from 'vitest';

const { httpsRequestMock } = vi.hoisted(() => ({
  httpsRequestMock: vi.fn(),
}));

vi.mock('https', () => ({
  default: {
    request: httpsRequestMock,
  },
}));

const { getAccountDb } = await import('#account-db');
const { SecretName, secretsService } =
  await import('#services/secrets-service');
const { resolveAccessKey } = await import('./app-simplefin.js');

describe('app-simplefin', () => {
  beforeEach(() => {
    httpsRequestMock.mockReset();
    secretsService.set(SecretName.simplefin_token, null);
    secretsService.set(SecretName.simplefin_accessKey, null);
    getAccountDb().mutate('DELETE FROM secrets WHERE name IN (?, ?)', [
      SecretName.simplefin_token,
      SecretName.simplefin_accessKey,
    ]);
  });

  it('reads the full access key response before caching it', async () => {
    mockTokenExchange([
      'https://simplefin-user:',
      'simplefin-password@bridge.simplefin.org/access-url\n',
    ]);
    secretsService.set(
      SecretName.simplefin_token,
      Buffer.from('https://bridge.simplefin.org/setup/token').toString(
        'base64',
      ),
    );

    const accessKey = await resolveAccessKey();

    expect(accessKey).toBe(
      'https://simplefin-user:simplefin-password@bridge.simplefin.org/access-url',
    );
    expect(secretsService.get(SecretName.simplefin_accessKey)).toBe(
      'https://simplefin-user:simplefin-password@bridge.simplefin.org/access-url',
    );
  });

  it('refreshes a malformed cached access key from the stored token', async () => {
    mockTokenExchange([
      'https://simplefin-user:simplefin-password@bridge.simplefin.org/access-url',
    ]);
    secretsService.set(
      SecretName.simplefin_token,
      Buffer.from('https://bridge.simplefin.org/setup/token').toString(
        'base64',
      ),
    );
    secretsService.set(SecretName.simplefin_accessKey, 'https://partial-key');

    const accessKey = await resolveAccessKey();

    expect(accessKey).toBe(
      'https://simplefin-user:simplefin-password@bridge.simplefin.org/access-url',
    );
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    expect(secretsService.get(SecretName.simplefin_accessKey)).toBe(
      'https://simplefin-user:simplefin-password@bridge.simplefin.org/access-url',
    );
  });
});

function mockTokenExchange(chunks) {
  httpsRequestMock.mockImplementation((_url, _options, callback) => {
    const handlers = {};
    const res = {
      setEncoding: vi.fn(),
      on: (event, handler) => {
        handlers[event] = handler;
      },
    };

    queueMicrotask(() => {
      callback(res);
      for (const chunk of chunks) {
        handlers.data?.(chunk);
      }
      handlers.end?.();
    });

    return {
      on: vi.fn(),
      end: vi.fn(),
    };
  });
}
