import path from 'path';

import { test, vi } from 'vitest';

import type * as ActualApiModule from '../index';

import type * as AutomationRegistry from './index';

declare global {
  var IS_TESTING: boolean;
  var currentMonth: string | null;
}

global.IS_TESTING = true;

vi.mock(
  '../../loot-core/src/platform/server/fs/index.api',
  async importOriginal => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    const lootCoreRoot = path.join(__dirname, '..', '..', 'loot-core');
    return {
      ...actual,
      bundledDatabasePath: path.join(lootCoreRoot, 'default-db.sqlite'),
      demoBudgetPath: path.join(lootCoreRoot, 'demo-budget'),
      migrationsPath: path.join(lootCoreRoot, 'migrations'),
    };
  },
);

const automationRunnerTest =
  process.env.ACTUAL_AUTOMATION_RUNNER === 'true' ? test : test.skip;

type ActualApi = typeof ActualApiModule;
type AvailableAutomations = typeof AutomationRegistry;

function envFlag(name: string) {
  return process.env[name] === 'true' || process.env[name] === '1';
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function normalizeAutomationName(name: string) {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

function findAutomation(
  availableAutomations: AvailableAutomations['availableAutomations'],
  name: string,
) {
  const normalizedName = normalizeAutomationName(name);
  return availableAutomations.find(automation => {
    return normalizeAutomationName(automation.name) === normalizedName;
  });
}

function formatBudgetList(
  budgets: Awaited<ReturnType<ActualApi['getBudgets']>>,
) {
  if (budgets.length === 0) {
    return 'No local budgets were found.';
  }

  return budgets
    .map(budget => {
      const name = budget.name ? ` (${budget.name})` : '';
      return `  ${budget.id}${name}`;
    })
    .join('\n');
}

async function initApi(api: ActualApi) {
  const dataDir = requiredEnv('ACTUAL_DATA_DIR');
  const serverURL = process.env.ACTUAL_SERVER_URL;
  const sessionToken = process.env.ACTUAL_SESSION_TOKEN;
  const password = process.env.ACTUAL_PASSWORD;
  const verbose = envFlag('ACTUAL_VERBOSE');

  if (serverURL && sessionToken) {
    await api.init({ dataDir, serverURL, sessionToken, verbose });
  } else if (serverURL && password) {
    await api.init({ dataDir, password, serverURL, verbose });
  } else {
    await api.init({ dataDir, verbose });
  }
}

async function initBudget(api: ActualApi) {
  const budgetId = process.env.ACTUAL_BUDGET_ID;
  const syncId = process.env.ACTUAL_SYNC_ID;

  await initApi(api);

  if (budgetId) {
    await api.loadBudget(budgetId);
    return;
  }

  if (syncId) {
    await api.downloadBudget(syncId, {
      password: process.env.ACTUAL_ENCRYPTION_PASSWORD,
    });
    return;
  }

  const budgets = await api.getBudgets();
  throw new Error(
    `ACTUAL_BUDGET_ID or ACTUAL_SYNC_ID is required.\nAvailable local budgets:\n${formatBudgetList(
      budgets,
    )}`,
  );
}

automationRunnerTest(
  'runs requested automation',
  async () => {
    const [api, automations] = await Promise.all([
      import('../index'),
      import('./index'),
    ]);

    try {
      if (envFlag('ACTUAL_AUTOMATION_LIST')) {
        process.stdout.write(
          JSON.stringify(
            automations.availableAutomations.map(automation => ({
              name: automation.name,
              version: automation.version ?? null,
            })),
            null,
            2,
          ) + '\n',
        );
        return;
      }

      if (envFlag('ACTUAL_AUTOMATION_LIST_BUDGETS')) {
        await initApi(api);
        const budgets = await api.getBudgets();
        process.stdout.write(
          JSON.stringify(
            budgets.map(budget => ({
              id: budget.id,
              name: budget.name ?? null,
              cloudFileId: budget.cloudFileId ?? null,
              groupId: budget.groupId ?? null,
            })),
            null,
            2,
          ) + '\n',
        );
        return;
      }

      const automationName = requiredEnv('ACTUAL_AUTOMATION');
      const automation = findAutomation(
        automations.availableAutomations,
        automationName,
      );

      if (!automation) {
        throw new Error(
          `Unknown automation "${automationName}". Available automations: ${automations.availableAutomations
            .map(item => `"${item.name}"`)
            .join(', ')}`,
        );
      }

      await initBudget(api);

      const apply = envFlag('ACTUAL_APPLY');
      const result = await api.runAutomation(automation, {
        allowDeletingLinkedTransfers: envFlag(
          'ACTUAL_ALLOW_DELETING_LINKED_TRANSFERS',
        ),
        allowReconciledTransactions: envFlag(
          'ACTUAL_ALLOW_RECONCILED_TRANSACTIONS',
        ),
        dryRun: !apply,
        runTransfers: envFlag('ACTUAL_RUN_TRANSFERS'),
      });

      process.stdout.write(JSON.stringify(result, null, 2) + '\n');

      if (!apply) {
        process.stderr.write(
          'Dry run only. Set ACTUAL_APPLY=true to write changes.\n',
        );
      } else if (!result.applied) {
        process.stderr.write(
          'No changes were applied because the automation reported preview errors.\n',
        );
      }
    } finally {
      await api.shutdown();
    }
  },
  120_000,
);
