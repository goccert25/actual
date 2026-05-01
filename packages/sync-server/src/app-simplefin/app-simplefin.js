import https from 'https';

import express from 'express';

import { handleError } from '#app-gocardless/util/handle-error';
import { SecretName, secretsService } from '#services/secrets-service';
import {
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from '#util/middlewares';

const app = express();
export { app as handlers, resolveAccessKey };
app.use(requestLoggerMiddleware);
app.use(express.json());
app.use(validateSessionMiddleware);

app.post(
  '/status',
  handleError(async (req, res) => {
    const token = secretsService.get(SecretName.simplefin_token);
    const configured = token != null && token !== 'Forbidden';

    res.send({
      status: 'ok',
      data: {
        configured,
      },
    });
  }),
);

app.post(
  '/accounts',
  handleError(async (req, res) => {
    try {
      const accessKey = await resolveAccessKey();

      const accounts = await getAccounts(accessKey, null, null, null, true);

      res.send({
        status: 'ok',
        data: {
          accounts: accounts.accounts,
        },
      });
    } catch {
      invalidToken(res);
    }
  }),
);

app.post(
  '/transactions',
  handleError(async (req, res) => {
    const { accountId, startDate } = req.body || {};

    let accessKey;
    try {
      accessKey = await resolveAccessKey();
    } catch {
      invalidToken(res);
      return;
    }

    if (Array.isArray(accountId) !== Array.isArray(startDate)) {
      console.log({ accountId, startDate });
      throw new Error(
        'accountId and startDate must either both be arrays or both be strings',
      );
    }
    if (Array.isArray(accountId) && accountId.length !== startDate.length) {
      console.log({ accountId, startDate });
      throw new Error('accountId and startDate arrays must be the same length');
    }

    const earliestStartDate = Array.isArray(startDate)
      ? startDate.reduce((a, b) => (a < b ? a : b))
      : startDate;
    let results;
    try {
      results = await getTransactions(
        accessKey,
        Array.isArray(accountId) ? accountId : [accountId],
        new Date(earliestStartDate),
      );
    } catch (e) {
      if (e.message === 'Forbidden') {
        invalidToken(res);
      } else {
        serverDown(e, res);
      }
      return;
    }

    let response = {};
    if (Array.isArray(accountId)) {
      for (let i = 0; i < accountId.length; i++) {
        const id = accountId[i];
        response[id] = getAccountResponse(results, id, new Date(startDate[i]));
      }
    } else {
      response = getAccountResponse(results, accountId, new Date(startDate));
    }

    if (results.hasError) {
      res.send({
        status: 'ok',
        data: !Array.isArray(accountId)
          ? results.errors[accountId][0]
          : {
            ...response,
            errors: results.errors,
          },
      });
      return;
    }

    res.send({
      status: 'ok',
      data: response,
    });
  }),
);

function logAccountError(results, accountId, data) {
  const errors = results.errors[accountId] || [];
  errors.push(data);
  results.errors[accountId] = errors;
  results.hasError = true;
}

function getAccountResponse(results, accountId, startDate) {
  const account =
    !results?.accounts || results.accounts.find(a => a.id === accountId);
  if (!account) {
    console.log(
      `The account "${accountId}" was not found. Here were the accounts returned:`,
    );
    if (results?.accounts) {
      results.accounts.forEach(a => console.log(`${a.id} - ${a.org.name}`));
    }
    logAccountError(results, accountId, {
      error_type: 'ACCOUNT_MISSING',
      error_code: 'ACCOUNT_MISSING',
      reason: `The account "${accountId}" was not found. Try unlinking and relinking the account.`,
    });
    return;
  }

  const needsAttention = results.sferrors.find(e =>
    e.startsWith(`Connection to ${account.org.name} may need attention`),
  );
  if (needsAttention) {
    logAccountError(results, accountId, {
      error_type: 'ACCOUNT_NEEDS_ATTENTION',
      error_code: 'ACCOUNT_NEEDS_ATTENTION',
      reason:
        'The account needs your attention at <a href="https://bridge.simplefin.org/auth/login">SimpleFIN</a>.',
    });
  }

  const startingBalance = parseInt(account.balance.replace('.', ''));
  const date = getDate(new Date(account['balance-date'] * 1000));

  const balances = [
    {
      balanceAmount: {
        amount: account.balance,
        currency: account.currency,
      },
      balanceType: 'expected',
      referenceDate: date,
    },
    {
      balanceAmount: {
        amount: account.balance,
        currency: account.currency,
      },
      balanceType: 'interimAvailable',
      referenceDate: date,
    },
  ];

  const all = [];
  const booked = [];
  const pending = [];

  for (const trans of account.transactions) {
    const newTrans = {};

    let dateToUse = 0;

    if (trans.pending ?? trans.posted === 0) {
      newTrans.booked = false;
      dateToUse = trans.transacted_at;
    } else {
      newTrans.booked = true;
      dateToUse = trans.posted;
    }

    const transactionDate = new Date(dateToUse * 1000);

    if (transactionDate < startDate) {
      continue;
    }

    newTrans.sortOrder = dateToUse;
    newTrans.date = getDate(transactionDate);
    newTrans.payeeName = trans.payee;
    newTrans.notes = trans.description;
    newTrans.transactionAmount = { amount: trans.amount, currency: 'USD' };
    newTrans.transactionId = trans.id;
    newTrans.valueDate = newTrans.bookingDate;

    if (trans.transacted_at) {
      newTrans.transactedDate = getDate(new Date(trans.transacted_at * 1000));
    }

    if (trans.posted) {
      newTrans.postedDate = getDate(new Date(trans.posted * 1000));
    }

    if (newTrans.booked) {
      booked.push(newTrans);
    } else {
      pending.push(newTrans);
    }
    all.push(newTrans);
  }

  const sortFunction = (a, b) => b.sortOrder - a.sortOrder;

  const bookedSorted = booked.sort(sortFunction);
  const pendingSorted = pending.sort(sortFunction);
  const allSorted = all.sort(sortFunction);

  return {
    balances,
    startingBalance,
    transactions: {
      all: allSorted,
      booked: bookedSorted,
      pending: pendingSorted,
    },
  };
}

function invalidToken(res) {
  res.send({
    status: 'ok',
    data: {
      error_type: 'INVALID_ACCESS_TOKEN',
      error_code: 'INVALID_ACCESS_TOKEN',
      status: 'rejected',
      reason:
        'Invalid SimpleFIN access token.  Reset the token and re-link any broken accounts.',
    },
  });
}

function serverDown(e, res) {
  console.log(e);
  res.send({
    status: 'ok',
    data: {
      error_type: 'SERVER_DOWN',
      error_code: 'SERVER_DOWN',
      status: 'rejected',
      reason: 'There was an error communicating with SimpleFIN.',
    },
  });
}

function normalizeSecretValue(secret) {
  return typeof secret === 'string' ? secret.trim() : secret;
}

function parseAccessKey(accessKey) {
  const normalizedAccessKey = normalizeSecretValue(accessKey);
  let scheme = null;
  let rest = null;
  let auth = null;
  let username = null;
  let password = null;
  let baseUrl = null;
  if (!normalizedAccessKey || !normalizedAccessKey.match(/^.*\/\/.*:.*@.*$/)) {
    console.log('Invalid SimpleFIN access key');
    console.log('Access Key');
    console.log(accessKey);
    console.log('Access Key Normalized');
    console.log(normalizedAccessKey);
    throw new Error(`Invalid access key`);
  }
  [scheme, rest] = normalizedAccessKey.split('//');
  [auth, rest] = rest.split('@');
  [username, password] = auth.split(':');
  baseUrl = `${scheme}//${rest}`;
  return {
    baseUrl,
    username,
    password,
  };
}

async function getAccessKey(base64Token) {
  const token = Buffer.from(normalizeSecretValue(base64Token), 'base64')
    .toString()
    .trim();
  const options = {
    method: 'POST',
    port: 443,
    headers: { 'Content-Length': 0 },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(token), options, res => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', d => {
        responseBody += d;
      });
      res.on('end', () => {
        resolve(normalizeSecretValue(responseBody));
      });
    });
    req.on('error', e => {
      reject(e);
    });
    req.end();
  });
}

async function resolveAccessKey() {
  let accessKey = normalizeSecretValue(
    secretsService.get(SecretName.simplefin_accessKey),
  );

  if (accessKey != null && accessKey !== 'Forbidden') {
    try {
      parseAccessKey(accessKey);
      return accessKey;
    } catch {
      accessKey = null;
    }
  }

  const token = normalizeSecretValue(
    secretsService.get(SecretName.simplefin_token),
  );
  if (token == null || token === 'Forbidden') {
    throw new Error('No token');
  }

  accessKey = await getAccessKey(token);
  if (accessKey == null || accessKey === 'Forbidden') {
    throw new Error('No access key');
  }

  parseAccessKey(accessKey);
  secretsService.set(SecretName.simplefin_accessKey, accessKey);
  return accessKey;
}

async function getTransactions(accessKey, accounts, startDate, endDate) {
  const now = new Date();
  startDate = startDate || new Date(now.getFullYear(), now.getMonth(), 1);
  endDate = endDate || new Date(now.getFullYear(), now.getMonth() + 1, 1);
  console.log(`${getDate(startDate)} - ${getDate(endDate)}`);
  return await getAccounts(accessKey, accounts, startDate, endDate);
}

function getDate(date) {
  return date.toISOString().split('T')[0];
}

function normalizeDate(date) {
  return (date.valueOf() - date.getTimezoneOffset() * 60 * 1000) / 1000;
}

async function getAccounts(
  accessKey,
  accounts,
  startDate,
  endDate,
  noTransactions = false,
) {
  const sfin = parseAccessKey(accessKey);

  const headers = {
    Authorization: `Basic ${Buffer.from(
      `${sfin.username}:${sfin.password}`,
    ).toString('base64')}`,
  };

  const params = new URLSearchParams();
  if (!noTransactions) {
    if (startDate) {
      params.append('start-date', normalizeDate(startDate));
    }
    if (endDate) {
      params.append('end-date', normalizeDate(endDate));
    }
    params.append('pending', '1');
  } else {
    params.append('balances-only', '1');
  }

  if (accounts) {
    for (const id of accounts) {
      params.append('account', id);
    }
  }

  const url = new URL(`${sfin.baseUrl}/accounts`);
  url.search = params.toString();

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers,
    redirect: 'follow',
  });

  if (response.status === 403) {
    throw new Error('Forbidden');
  }

  const text = await response.text();
  try {
    const results = JSON.parse(text);
    results.sferrors = results.errors;
    results.hasError = false;
    results.errors = {};
    return results;
  } catch (e) {
    console.log(`Error parsing JSON response: ${text}`);
    throw e;
  }
}
