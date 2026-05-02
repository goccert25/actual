```
npm install @actual-app/api
```

View docs here: https://actualbudget.org/docs/api/

## TypeScript

`@actual-app/api` publishes TypeScript declarations. Consumers using TypeScript must set `moduleResolution` to `"bundler"`, `"nodenext"`, or `"node16"` in their `tsconfig.json`. Legacy `"node"` / `"node10"` / `"classic"` resolution is not supported in strict mode — the published declarations rely on package.json `exports` conditions that older resolvers don't honor.

## Code-first automations

The API package includes a small automation runner for local TypeScript scripts.
Automations are intended to live as code in your own repository and return a
reviewable plan. Dry runs are the default.

```ts
import * as api from '@actual-app/api';

const automation = api.defineAutomation({
  name: 'wealthfront venmo cleanup',
  async plan(ctx) {
    const plan = ctx.createPlan();
    const wealthfront = ctx.accountByName("Helen's Wealthfront");
    const venmoAccounts = ctx.accountsByNamePrefix("Helen's Venmo");

    if (!wealthfront || venmoAccounts.length === 0) {
      plan.skip('Required accounts were not found');
      return plan;
    }

    const wealthfrontTransactions = await ctx.queryTransactions({
      accountIds: [wealthfront.id],
      notesContains: 'Venmo-Payment',
      splits: 'none',
    });
    const venmoTransactions = await ctx.queryTransactions({
      accountIds: venmoAccounts.map(account => account.id),
      splits: 'none',
    });

    for (const transaction of wealthfrontTransactions) {
      const matches = venmoTransactions.filter(match => {
        return match.amount === transaction.amount;
      });

      if (matches.length !== 1) {
        plan.skip(
          `Expected one Venmo match, found ${matches.length}`,
          transaction.id,
        );
        continue;
      }

      const [match] = matches;
      plan.updateTransaction(
        transaction.id,
        { notes: match.notes || transaction.notes },
        'Copy notes from matched Venmo transaction',
      );
      plan.deleteTransaction(match.id, 'Remove matched Venmo duplicate');
    }

    return plan;
  },
});

await api.init({ dataDir: '/path/to/actual-data' });
await api.loadBudget('My Budget');

const dryRun = await api.runAutomation(automation);
console.log(dryRun.summary, dryRun.previews);

const applied = await api.runAutomation(automation, { dryRun: false });
console.log(applied.summary);
```

Checked-in automations can also be run from the repository root. The runner
prints the full plan and preview JSON, and it does not write changes unless
`--apply` is passed.

There are two ways to run an automation, depending on how you run Actual:

- Local budget mode: point `ACTUAL_DATA_DIR` at the directory that contains
  budget folders such as `<budget-id>/metadata.json` and `<budget-id>/db.sqlite`.
  In a desktop setup, this is usually `~/Documents/Actual`, not the app's
  internal user-data directory.
- Sync-server mode: point `ACTUAL_DATA_DIR` at a throwaway local cache
  directory, and provide `ACTUAL_SERVER_URL`, `ACTUAL_PASSWORD` (or
  `ACTUAL_SESSION_TOKEN`), and `ACTUAL_SYNC_ID`. This is the right choice when
  Actual is running through a sync server, including Docker deployments.

```sh
yarn workspace @actual-app/api automation:list

ACTUAL_DATA_DIR=/path/to/actual-data \
yarn workspace @actual-app/api automation:budgets

# Local budget mode
ACTUAL_DATA_DIR=/path/to/actual-data \
ACTUAL_BUDGET_ID=<budget-id> \
ACTUAL_AUTOMATION="Wealthfront Venmo cleanup" \
yarn workspace @actual-app/api automation

# Local budget mode, apply changes
ACTUAL_DATA_DIR=/path/to/actual-data \
ACTUAL_BUDGET_ID=<budget-id> \
ACTUAL_AUTOMATION="Wealthfront Venmo cleanup" \
ACTUAL_APPLY=true \
yarn workspace @actual-app/api automation

# Sync-server mode, dry run
ACTUAL_DATA_DIR=/tmp/actual-automation-cache \
ACTUAL_SERVER_URL=http://localhost:5006 \
ACTUAL_PASSWORD=your-server-password \
ACTUAL_SYNC_ID=08486f74-b28d-4f3f-93c8-6b56a23681e4 \
ACTUAL_AUTOMATION="Wealthfront Venmo cleanup" \
yarn workspace @actual-app/api automation

# Sync-server mode, apply changes
ACTUAL_DATA_DIR=/tmp/actual-automation-cache \
ACTUAL_SERVER_URL=http://localhost:5006 \
ACTUAL_PASSWORD=your-server-password \
ACTUAL_SYNC_ID=08486f74-b28d-4f3f-93c8-6b56a23681e4 \
ACTUAL_AUTOMATION="Wealthfront Venmo cleanup" \
ACTUAL_APPLY=true \
yarn workspace @actual-app/api automation
```

When running against a Dockerized sync server, `ACTUAL_SERVER_URL` should be
the host-reachable URL for the published server port. If you are running the
automation on the same machine as Docker and publishing port `5006`, that is
usually `http://localhost:5006`.

In sync-server mode, `ACTUAL_DATA_DIR` is only a local cache for the automation
client. It should not point at the sync server's own data directory.

When asking an AI tool to write one of these scripts, provide the automation
goal, account/payee names, matching rules, and the safety contract: the script
must only call `ctx.createPlan()` operations, skip ambiguous matches, and rely
on `api.runAutomation()` for dry-run/apply behavior.
