# Using the API

import { Method, MethodBox } from './types';

:::warning

Many people mistake the term "API" for a HTTP and/or REST-full API. Actual **does not** expose HTTP endpoints that can be called. We do, however, offer a NPM package - API - that allows interacting with the product programmatically.

:::

The API gives you full programmatic access to your data. It allows to run the UI in _headless_ mode thus interacting with it as-if it was a user clicking around in it. If you are a developer, you can use this to import transactions from a custom source, export data to another app like Excel, or write anything you want on top of Actual.

One thing to keep in mind: Actual is not like most other apps. While your data is stored on a server, the server does not have the functionality for analyzing details of or modifying your budget. As a result, the API client contains all the code necessary to query your data and will work on a local copy. Right now, the primary use case is custom importers and exporters.

## Getting Started

We provide an official Node.js client in the `@actual-app/api` package. Other languages are not supported at this point.

The client is [open-source on GitHub](https://github.com/actualbudget/actual/tree/master/packages/api) along with the rest of Actual if you want to see the code.

Install it with either `npm` or `yarn`:

```
npm install --save @actual-app/api
```

```
yarn add @actual-app/api
```

### TypeScript

`@actual-app/api` ships TypeScript declarations. To consume them, your `tsconfig.json` must use a modern `moduleResolution`:

```json
{
  "compilerOptions": {
    "moduleResolution": "bundler" // or "nodenext" / "node16"
  }
}
```

Legacy `"node"` / `"node10"` / `"classic"` resolution is not supported in strict TypeScript mode. The published declarations rely on package.json `exports` conditions, which older resolvers don't honor.

### Connecting to a Remote Server

Next, you'll need connect to your running server version of Actual to access your budget files.

```js
let api = require('@actual-app/api');

(async () => {
  await api.init({
    // Budget data will be cached locally here, in subdirectories for each file.
    dataDir: '/some/path',
    // This is the URL of your running server
    serverURL: 'http://localhost:5006',
    // This is the password you use to log into the server
    password: 'hunter2',
  });

  // This is the ID from Settings → Show advanced settings → Sync ID
  await api.downloadBudget('1cfdbb80-6274-49bf-b0c2-737235a4c81f');
  // or, if you have end-to-end encryption enabled:
  await api.downloadBudget('1cfdbb80-6274-49bf-b0c2-737235a4c81f', {
    password: 'password1',
  });

  let budget = await api.getBudgetMonth('2019-10');
  console.log(budget);
  await api.shutdown();
})();
```

Heads up! You probably don't want to hard-code the passwords like that, especially if you'll be using Git to track your code. You can use environment variables to store the passwords instead, or read them in from a file, or request them interactively when running the script instead.

### Running Automations

The code-first automation runner in the monorepo supports two execution modes:

- Local budget mode: use this if you have budget folders on disk already. Point
  `ACTUAL_DATA_DIR` at the directory that contains budget folders such as
  `<budget-id>/metadata.json` and `<budget-id>/db.sqlite`. In a desktop setup,
  this is usually `~/Documents/Actual`.
- Sync-server mode: use this if Actual is running through a sync server,
  including Docker deployments. Point `ACTUAL_DATA_DIR` at a local cache
  directory, then provide `ACTUAL_SERVER_URL`, `ACTUAL_PASSWORD` or
  `ACTUAL_SESSION_TOKEN`, and `ACTUAL_SYNC_ID`.

Examples from the repository root:

```sh
# List registered automations
yarn workspace @actual-app/api automation:list

# List locally available budgets
ACTUAL_DATA_DIR=~/Documents/Actual \
yarn workspace @actual-app/api automation:budgets

# Dry run against a local budget folder
ACTUAL_DATA_DIR=~/Documents/Actual \
ACTUAL_BUDGET_ID=<budget-id> \
ACTUAL_AUTOMATION="Wealthfront Venmo cleanup" \
yarn workspace @actual-app/api automation

# Dry run against a running sync server
ACTUAL_DATA_DIR=/tmp/actual-automation-cache \
ACTUAL_SERVER_URL=http://localhost:5006 \
ACTUAL_PASSWORD=your-server-password \
ACTUAL_SYNC_ID=08486f74-b28d-4f3f-93c8-6b56a23681e4 \
ACTUAL_AUTOMATION="Wealthfront Venmo cleanup" \
yarn workspace @actual-app/api automation

# Apply changes against a running sync server
ACTUAL_DATA_DIR=/tmp/actual-automation-cache \
ACTUAL_SERVER_URL=http://localhost:5006 \
ACTUAL_PASSWORD=your-server-password \
ACTUAL_SYNC_ID=08486f74-b28d-4f3f-93c8-6b56a23681e4 \
ACTUAL_AUTOMATION="Wealthfront Venmo cleanup" \
ACTUAL_APPLY=true \
yarn workspace @actual-app/api automation
```

If your sync server is running in Docker and port `5006` is published to the
host, `ACTUAL_SERVER_URL` is usually `http://localhost:5006`.

In sync-server mode, `ACTUAL_DATA_DIR` is only the API client's local cache.
Do not point it at the sync server's own storage directory.

### Self-Signed Https Certificates

If the serverURL is using [self-signed or custom CA certificates](../config/https.md), additional Node.js configuration will be needed for the connections to succeed.

The API communicates with the server using Node's built-in `fetch`. There are a few ways to get Node.js to trust the self-signed certificate.

- Option 1: Point environment variable [NODE_EXTRA_CA_CERTS](https://nodejs.org/api/cli.html#node_extra_ca_certsfile) to the path of a file containing the public certificate.
- Option 2: Set environment variable [NODE_TLS_REJECT_UNAUTHORIZED](https://nodejs.org/api/cli.html#node_tls_reject_unauthorizedvalue) to `0`. Not recommended if your program reaches out to any other endpoints other than the Actual server.
- Options 3: Use OpenSSL CA certificates configuration for Node and add your certificate to the OpenSSL SSL_CERT_DIR. What this requires depends on your build of Node.js, and the configuration details are beyond the scope of this documentation. See the [Node.js OpenSSL Strategy](https://github.com/nodejs/TSC/blob/main/OpenSSL-Strategy.md) page for a starting point.

## Writing Data Importers

If you are using another app, like YNAB or Mint, you might want to migrate your data into Actual. Right now, Actual officially supports [importing YNAB4 data](../migration/ynab4.md) and [importing nYNAB data](../migration/nynab.md) (and it works very well). But if you want to import all of your data into Actual, you can write a custom importer.

Note that this is not about importing transactions. If all you want to do is add transactions from a custom source (like your bank's API), use [`importTransactions`](./reference.md#importtransactions). In this context, a custom importer is something that takes _all_ of your data (budgets, transactions, payees, etc) and dumps them all into a new file in Actual.

The API has a special mode for bulk importing data. In this mode, a new file is always created (you can't bulk import into an existing file), and it will run much faster than if you did it normally.

To write a custom importer, use `runImport`. It takes the _name_ of the file you want to create and runs a function. Here is an example importer:

```js
let api = require('@actual-app/api');
let data = require('my-data.json');

async function run() {
  for (let account of data.accounts) {
    let acctId = await api.createAccount(convertAccount(account));
    await api.addTransactions(
      acctId,
      data.transactions
        .filter(t => t.acctId === acctId)
        .map(convertTransaction),
    );
  }
}

api.runImport('My-Budget', run);
```

This is very simple, but it takes some data in `my-data.json` and creates all the accounts and transactions from it. Functions used to convert items (like `convertAccount`) are not included here. Use the [reference docs](./reference.md) to learn the shape of objects that Actual expects.

**Note:** it's important that [`addTransactions`](./reference.md#addtransactions) is used here. You want to use it instead of [`importTransactions`](./reference.md#importtransactions) when dumping raw data into Actual. The former will not run the reconciliation process (which deduplicates transactions), and won't create the other side of transfer transactions, and more. If you use `importTransactions` it may adjust your data in ways that don't match the data you're importing.

Check out the [YNAB4](https://github.com/actualbudget/actual/blob/master/packages/loot-core/src/server/importers/ynab4.ts) and [YNAB5](https://github.com/actualbudget/actual/blob/master/packages/loot-core/src/server/importers/ynab5.ts) importers to see how a real importer works.

## Methods

These are the public methods that you can use. The API also exports low-level functions like `init`, `send`, `disconnect`, and `loadBudget` if you want to manually manage the connection. You can [read the source](https://github.com/actualbudget/actual/blob/master/packages/loot-core/src/server/main.ts) to learn about those methods (search for `export const lib`).

#### `init`

<Method name="init" argsObject={true} args={[{ properties: [{ name: 'dataDir', type: 'string' }, { name: 'serverURL', type: 'string' }, { name: 'password', type: 'string' }, { name: 'verbose', type: 'boolean' }]}]} returns="Promise<void>" />

Call this before attempting to use any of the API methods. This will connect to the server using the provided password and load the budget data.

`dataDir` defaults to the current working directory.

If no `serverURL` is provided, no network connections will be made, and you'll only be able to access budget files already downloaded locally.

You can find your budget id in the "Advanced" section of the settings page.

#### `shutdown`

<Method name="shutdown" args={[]} returns="Promise<void>" />

Close the current budget file, and stop any other ongoing processes. It's recommended to call this before exiting your script.

#### `utils.amountToInteger`

<Method name="utils.amountToInteger" args={[{ name: 'amount', type: 'number' }]} returns="number" />

Convert a currency amount (such as `123.45`) represented as a floating point number to the integer format Actual uses internally (i.e. `12345`).

#### `utils.integerToAmount`

<Method name="utils.integerToAmount" args={[{ name: 'amount', type: 'number' }]} returns="number" />

Convert an integer amount as used internally by Actual (such as `12345`) to the traditional floating point (i.e. `123.45`).
