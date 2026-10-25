import type { NessieAddress, NessieClient } from "@/integrations/nessie";

/**
 * Test data for the Nessie sandbox: one customer (Margaret), one checking
 * account, and about three months of realistic purchases. Dates are relative to
 * `today` so the demo always has a current and a previous month.
 *
 * Built-in signals the analysis should find:
 *  - monthly subscriptions: StreamTV, Bay Internet, FitLife Gym, CloudPhotos Plus
 *  - a price increase: Daily Gazette $9.99 -> $12.99 this month
 * and look-alikes it must NOT flag: weekly groceries, a utility bill that
 * varies month to month, pharmacy refills at different prices.
 */

const ADDRESS: NessieAddress = { street_number: "1420", street_name: "Shattuck Ave", city: "Berkeley", state: "CA", zip: "94709" };

export interface FixtureMerchant {
  key: string;
  name: string;
  category: string;
}

export const FIXTURE_MERCHANTS: FixtureMerchant[] = [
  { key: "safeway", name: "Safeway", category: "Grocery" },
  { key: "cvs", name: "CVS Pharmacy", category: "Pharmacy" },
  { key: "streamtv", name: "StreamTV", category: "Streaming Entertainment" },
  { key: "internet", name: "Bay Internet", category: "Telecom Internet" },
  { key: "pge", name: "PG&E", category: "Utilities" },
  { key: "cloudphotos", name: "CloudPhotos Plus", category: "Online Services" },
  { key: "gym", name: "FitLife Gym", category: "Fitness" },
  { key: "gazette", name: "Daily Gazette", category: "Newspaper" },
  { key: "diner", name: "Mel's Diner", category: "Restaurant" },
];

/** [merchantKey, day of month, amount] for months ago 2, 1 and 0. */
const PLAN: Record<0 | 1 | 2, [string, number, number][]> = {
  2: [
    ["gym", 1, 29.99], ["safeway", 2, 64.12], ["streamtv", 3, 15.99], ["cvs", 6, 18.4], ["cloudphotos", 8, 2.99],
    ["safeway", 9, 47.85], ["internet", 12, 59.99], ["gazette", 15, 9.99], ["safeway", 16, 71.3], ["diner", 18, 23.5],
    ["pge", 20, 92.14], ["safeway", 23, 52.66],
  ],
  1: [
    ["gym", 1, 29.99], ["safeway", 2, 58.4], ["streamtv", 3, 15.99], ["cvs", 6, 31.25], ["cloudphotos", 8, 2.99],
    ["safeway", 9, 66.02], ["internet", 12, 59.99], ["gazette", 15, 9.99], ["safeway", 16, 49.77], ["diner", 21, 31.8],
    ["pge", 20, 88.4], ["safeway", 23, 61.15],
  ],
  0: [
    ["gym", 1, 29.99], ["safeway", 2, 62.9], ["streamtv", 3, 15.99], ["cvs", 6, 24.1], ["cloudphotos", 8, 2.99],
    ["safeway", 9, 55.48], ["internet", 12, 59.99], ["gazette", 15, 12.99], ["safeway", 16, 73.05], ["diner", 17, 18.25],
    ["pge", 20, 101.73], ["safeway", 23, 44.6],
  ],
};

function dateFor(today: string, monthsAgo: number, day: number): string | null {
  const [y, m, d] = today.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 - monthsAgo, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  if (monthsAgo === 0 && day > d) return null; // not yet happened this month
  const date = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, lastDay)));
  return date.toISOString().slice(0, 10);
}

export interface ProvisionedBank {
  customerId: string;
  accountId: string;
  nickname: string;
  last4: string;
  merchantIds: Record<string, string>;
  purchasesCreated: number;
}

/** Set up a Nessie customer + checking account and populate it with test purchases. */
export async function provisionSandboxBank(nessie: NessieClient, today: string): Promise<ProvisionedBank> {
  const customer = await nessie.createCustomer({ first_name: "Margaret", last_name: "Hale", address: ADDRESS });
  const accountNumber = `4${String(Math.floor(Math.random() * 1e15)).padStart(15, "0")}`;
  const account = await nessie.createAccount(customer._id, {
    type: "Checking",
    nickname: "Everyday Checking",
    rewards: 0,
    balance: 4200,
    account_number: accountNumber,
  });

  const merchantIds: Record<string, string> = {};
  for (const m of FIXTURE_MERCHANTS) {
    const created = await nessie.createMerchant({ name: m.name, category: m.category, address: ADDRESS, geocode: { lat: 37.88, lng: -122.27 } });
    merchantIds[m.key] = created._id;
  }

  let purchasesCreated = 0;
  for (const monthsAgo of [2, 1, 0] as const) {
    for (const [key, day, amount] of PLAN[monthsAgo]) {
      const date = dateFor(today, monthsAgo, day);
      if (!date) continue;
      await nessie.createPurchase(account._id, {
        merchant_id: merchantIds[key],
        medium: "balance",
        purchase_date: date,
        amount,
        status: "completed",
        description: FIXTURE_MERCHANTS.find((m) => m.key === key)!.name,
      });
      purchasesCreated++;
    }
  }

  return {
    customerId: customer._id,
    accountId: account._id,
    nickname: account.nickname,
    // Only the last 4 digits are ever kept; the full number stays at the bank.
    last4: (account.account_number ?? accountNumber).slice(-4),
    merchantIds,
    purchasesCreated,
  };
}
