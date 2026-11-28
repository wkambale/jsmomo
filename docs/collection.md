# Collection

The MTN MoMo **Collection** product (`client.collection`) collects funds from subscribers via Request to Pay, Request to Withdraw, account balance lookups, subscriber validation, and CIBA OAuth2 consent flows.

## Request to Pay

```ts
const referenceId = await client.collection.requestToPay({
  amount: "5000",
  currency: "UGX",
  payerMsisdn: "256772123456",
  externalId: "invoice-42",
  payerMessage: "Invoice #42",
  payeeNote: "Paid via JS MoMo SDK",
  // Optional: supply your own UUID v4 for idempotency
  // referenceId: "550e8400-e29b-41d4-a716-446655440000",
});

const status = await client.collection.getPaymentStatus(referenceId);
if (status.isSuccessful()) {
  console.log("Financial TX:", status.financialTransactionId);
  await client.collection.requestToPayDeliveryNotification(
    referenceId,
    "Order #42 confirmed — thank you!",
    { language: "en" },
  );
}
```

## PreApproval (v2)

Authorize recurring or pre-approved subscriber debits (`POST /collection/v2_0/preapproval`):

```ts
const preApprovalRef = await client.collection.preApprove({
  payerMsisdn: "256772123456",
  payerCurrency: "UGX",
  payerMessage: "Authorize monthly subscription",
  validityTime: 3600,
});

const preApproval = await client.collection.getPreApprovalStatus(preApprovalRef);
console.log(preApproval.status, preApproval.expirationDateTime);
```

## Request to Withdraw (v2)

```ts
const withdrawRef = await client.collection.requestToWithdraw({
  amount: "10000",
  currency: "UGX",
  payerMsisdn: "256772123456",
  externalId: "wd-101",
});

const withdrawStatus = await client.collection.getWithdrawStatus(withdrawRef);
console.log(withdrawStatus.status);
```

## Balance & subscriber lookups

```ts
const balance = await client.collection.getBalance();
const ugxBalance = await client.collection.getBalanceForCurrency("UGX");

const active = await client.collection.isAccountHolderActive("256772123456");
const userInfo = await client.collection.getBasicUserInfo("256772123456");
```

## CIBA backchannel authorization & OAuth2 consent tokens

```ts
const bc = await client.collection.bcAuthorize({
  loginHint: "ID:256772123456/MSISDN",
  scope: "profile",
  accessType: "offline",
});

const oauthToken = await client.collection.createOAuth2Token({
  authReqId: bc.authReqId,
});

// Refresh using a previously issued refresh token
if (oauthToken.refreshToken) {
  const refreshed = await client.collection.createOAuth2Token({
    grantType: "refresh_token",
    refreshToken: oauthToken.refreshToken,
  });
  console.log("Refreshed TTL:", refreshed.expiresIn);
}

const consentedUser = await client.collection.getUserInfoWithConsent(
  oauthToken.accessToken,
);
console.log(consentedUser.givenName);
```
