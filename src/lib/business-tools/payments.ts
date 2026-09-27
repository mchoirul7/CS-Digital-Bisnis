import type { BusinessToolContext } from "./recorder";
import type { PublicPaymentAccount } from "./types";

/**
 * Rekening hanya boleh berasal dari tabel payment_accounts yang aktif.
 */
export async function getPaymentAccounts(
  context: BusinessToolContext,
): Promise<PublicPaymentAccount[]> {
  return context.recorder.run("get_payment_accounts", {}, async () => {
    const accounts = await context.repository.listPaymentAccounts(context.companyId);

    return accounts.map((account) => ({
      id: account.id,
      bank_name: account.bank_name,
      account_number: account.account_number,
      account_name: account.account_name,
    }));
  });
}
