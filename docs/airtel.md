# Airtel Money

JS MoMo SDK ships first-class support for the **Airtel Money Open API** across 15+ African markets (including Uganda, Kenya, Tanzania, Rwanda, Zambia, Malawi, Nigeria, Ghana, DRC, Madagascar, Gabon, Congo-Brazzaville, Chad, Niger, and Seychelles) via `AirtelClient`, `AirtelConfig`, and `encryptAirtelPin()`.

## Encrypting the disbursement PIN

Production Airtel Money disbursements require an RSA PKCS#1 v1.5 encrypted Base64 PIN. JS MoMo SDK encrypts PINs using Node's native `node:crypto` — no extra dependencies required:

```ts
import { readFileSync } from "node:fs";
import { encryptAirtelPin } from "js-momo-sdk";

const publicKeyPem = readFileSync("./airtel_public_key.pem", "utf8");
const encryptedPin = encryptAirtelPin("1234", publicKeyPem);
```

In `environment: "production"`, `AirtelConfig` automatically rejects plaintext numeric PINs and too-short Base64 payloads to prevent accidental credential exposure.

## Collection, Disbursement, and Balance

```ts
import { AirtelClient, AirtelConfig } from "js-momo-sdk";

const config = new AirtelConfig({
  clientId: process.env.JS_MOMO_SDK_AIRTEL_CLIENT_ID!,
  clientSecret: process.env.JS_MOMO_SDK_AIRTEL_CLIENT_SECRET!,
  country: "UG",
  currency: "UGX",
  environment: "sandbox",
  pin: process.env.JS_MOMO_SDK_AIRTEL_PIN,
});

const airtel = new AirtelClient(config);

try {
  // USSD Push collection (normalizes +256752123456 -> 752123456 automatically)
  const colRef = await airtel.collection.requestToPay({
    amount: "5000",
    payerMsisdn: "+256752123456",
    externalId: "ORDER-100",
  });

  const colStatus = await airtel.collection.getPaymentStatus(colRef);
  console.log("Success:", colStatus.isSuccessful());

  // Disbursement payout
  const disbRef = await airtel.disbursement.transfer({
    amount: "2000",
    payeeMsisdn: "+256752123456",
    transactionType: "B2C",
    walletType: "NORMAL",
  });

  const disbStatus = await airtel.disbursement.getTransferStatus(disbRef);
  console.log("Pending:", disbStatus.isPending());

  // Wallet balance
  const wallet = await airtel.disbursement.getBalance();
  console.log(wallet.data.wallet.balance, wallet.data.wallet.currency);
} finally {
  airtel.close();
}
```

## HTTP 200 business-rejection handling

Airtel Money often returns HTTP `200 OK` with `status.success === false` or `data.transaction.status === "TF"`. JS MoMo SDK inspects every Airtel envelope automatically via `checkAirtelResponseStatus()` and raises `TransactionFailedError`, `BadRequestError`, or `JsMomoSDKError` with `referenceId`, `errorCode`, `reason`, and `provider: "Airtel Money"` attached.
