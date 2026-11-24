# Remittance

The MTN MoMo **Remittance** product (`client.remittance`) executes cross-border and wallet-to-wallet transfers.

## Initiate a remittance transfer

```ts
import { JsMomoSDK, JsMomoSDKConfig, ProductConfig } from "js-momo-sdk";

const client = new JsMomoSDK(
  new JsMomoSDKConfig({
    environment: "sandbox",
    remittance: new ProductConfig({
      subscriptionKey: process.env.JS_MOMO_SDK_REMITTANCE_SUBSCRIPTION_KEY!,
      apiUser: process.env.JS_MOMO_SDK_REMITTANCE_API_USER!,
      apiKey: process.env.JS_MOMO_SDK_REMITTANCE_API_KEY!,
    }),
  }),
);

try {
  const referenceId = await client.remittance.transfer({
    amount: "50000",
    currency: "UGX",
    payeeMsisdn: "256772123456",
    externalId: "remit-2026-01",
    payerMessage: "Family remittance",
    payeeNote: "Received via Remittance API",
  });

  const result = await client.remittance.getTransferStatus(referenceId);
  console.log(result.status, result.financialTransactionId);

  const balance = await client.remittance.getBalance();
  console.log(balance.availableBalance, balance.currency);
} finally {
  client.close();
}
```

`client.remittance` also exposes `getBalanceForCurrency(currency)`, `isAccountHolderActive(accountHolderId)`, and `getBasicUserInfo(accountHolderId)`.
