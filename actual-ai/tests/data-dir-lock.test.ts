import fs from 'fs';
import os from 'os';
import path from 'path';
import ActualApiService from '../src/actual-api-service';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'actual-ai-lock-test-'));
}

function makeClient() {
  return {
    init: jest.fn(async () => Promise.resolve()),
    downloadBudget: jest.fn(async () => Promise.resolve()),
    shutdown: jest.fn(async () => Promise.resolve()),
    getCategoryGroups: jest.fn(),
    getCategories: jest.fn(),
    getPayees: jest.fn(),
    getAccounts: jest.fn(),
    getTransactions: jest.fn(),
    getRules: jest.fn(),
    getPayeeRules: jest.fn(),
    createRule: jest.fn(),
    updateTransaction: jest.fn(),
    runBankSync: jest.fn(),
    createCategory: jest.fn(),
    createCategoryGroup: jest.fn(),
    updateCategoryGroup: jest.fn(),
  } as unknown as typeof import('@actual-app/api');
}

function makeService(client: typeof import('@actual-app/api'), dataDir: string) {
  return new ActualApiService(
    client,
    fs,
    dataDir,
    'http://example.com',
    'pw',
    'budget',
    '',
    true,
  );
}

function writeLock(dataDir: string, pid: number, startedAt: Date) {
  const lockPath = path.join(dataDir, '.actual-ai.lock');
  fs.writeFileSync(lockPath, JSON.stringify({
    pid,
    startedAt: startedAt.toISOString(),
  }));
}

describe('ActualApiService dataDir lock', () => {
  test('releases lock when init() fails', async () => {
    const dataDir = makeTmpDir();
    const client = makeClient();
    (client.init as jest.Mock).mockRejectedValueOnce(new Error('network-failure'));

    const s1 = makeService(client, dataDir);

    await expect(s1.initializeApi()).rejects.toThrow('network-failure');

    // Lock should be released, so a second attempt should succeed
    (client.init as jest.Mock).mockResolvedValueOnce(undefined);
    (client.downloadBudget as jest.Mock).mockResolvedValueOnce(undefined);

    const s2 = makeService(client, dataDir);
    await expect(s2.initializeApi()).resolves.toBeUndefined();
    await s2.shutdownApi();
  });

  test('removes stale lock with self PID (PID reuse in containers)', async () => {
    const dataDir = makeTmpDir();

    // Write a lock file with the current process PID (simulating PID reuse)
    writeLock(dataDir, process.pid, new Date());

    const client = makeClient();
    const s1 = makeService(client, dataDir);

    // Should succeed by removing the stale self-PID lock
    await expect(s1.initializeApi()).resolves.toBeUndefined();
    await s1.shutdownApi();
  });

  test('removes stale lock older than 12 hours', async () => {
    const dataDir = makeTmpDir();

    // Write a lock file with a different PID and a timestamp > 12 hours ago
    const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60 * 1000);
    writeLock(dataDir, 999999, thirteenHoursAgo);

    const client = makeClient();
    const s1 = makeService(client, dataDir);

    // Should succeed by removing the stale lock
    await expect(s1.initializeApi()).resolves.toBeUndefined();
    await s1.shutdownApi();
  });

  test('refuses to start if lock is held by a different live process with recent timestamp', async () => {
    const dataDir = makeTmpDir();

    // Use the parent PID — it's always running while we are and is
    // different from our own PID, so neither the self-PID nor staleness
    // checks will clear the lock.
    writeLock(dataDir, process.ppid, new Date());

    const client = makeClient();
    const s1 = makeService(client, dataDir);

    await expect(s1.initializeApi()).rejects.toThrow(/Refusing to use shared dataDir/i);
  });

  test('removes lock with dead PID regardless of timestamp', async () => {
    const dataDir = makeTmpDir();

    // Use a PID that definitely doesn't exist (very high number)
    writeLock(dataDir, 999999, new Date());

    const client = makeClient();
    const s1 = makeService(client, dataDir);

    // Should succeed because the PID is dead (ESRCH), even though timestamp is recent
    await expect(s1.initializeApi()).resolves.toBeUndefined();
    await s1.shutdownApi();
  });
});