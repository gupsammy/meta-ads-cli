import { paginateAll, graphRequestWithRetry } from '../lib/http.js';
import type { PaginatedResult } from '../lib/http.js';
import type { AccountResult, ListAccountsOptions } from './types.js';

interface RawAdAccount {
  id: string;
  name: string;
  account_id: string;
  account_status: number;
  currency: string;
  timezone_name: string;
  amount_spent: string;
}

const ACCOUNT_FIELDS = 'id,name,account_id,account_status,currency,timezone_name,amount_spent';

const ACCOUNT_STATUS_MAP: Record<number, string> = {
  1: 'ACTIVE',
  2: 'DISABLED',
  3: 'UNSETTLED',
  7: 'PENDING_RISK_REVIEW',
  8: 'PENDING_SETTLEMENT',
  9: 'IN_GRACE_PERIOD',
  100: 'PENDING_CLOSURE',
  101: 'CLOSED',
  201: 'ANY_ACTIVE',
  202: 'ANY_CLOSED',
};

function mapAccount(a: RawAdAccount): AccountResult {
  return {
    id: a.id,
    name: a.name,
    account_id: a.account_id,
    status: ACCOUNT_STATUS_MAP[a.account_status] ?? String(a.account_status),
    currency: a.currency,
    timezone: a.timezone_name,
    amount_spent: a.amount_spent,
  };
}

export function normalizeAccountId(id: string): string {
  return id.startsWith('act_') ? id : `act_${id}`;
}

export async function listAccounts(
  token: string,
  opts: ListAccountsOptions = {},
): Promise<PaginatedResult<AccountResult>> {
  const params: Record<string, string> = { fields: ACCOUNT_FIELDS };
  if (opts.after) params['after'] = opts.after;

  const limit = opts.limit ?? 50;

  const result = await paginateAll<RawAdAccount>(
    '/me/adaccounts',
    token,
    { params },
    limit,
  );

  return {
    data: result.data.map(mapAccount),
    has_more: result.has_more,
    next_cursor: result.next_cursor,
  };
}

export async function getAccount(
  token: string,
  accountId: string,
): Promise<AccountResult> {
  const id = normalizeAccountId(accountId);
  const params: Record<string, string> = { fields: ACCOUNT_FIELDS };

  const account = await graphRequestWithRetry<RawAdAccount>(`/${id}`, token, { params });
  return mapAccount(account);
}
