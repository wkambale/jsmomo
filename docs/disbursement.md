# Disbursement

The MTN MoMo **Disbursement** product (`client.disbursement`) pays funds out to subscribers via transfers, v2 deposits, and refunds.

## Transfer

```ts
const referenceId = await client.disbursement.transfer({
  amount: "25000",
  currency: "UGX",
  payeeMsisdn: "256772123456",
  externalId: "payroll-001",
  payerMessage: "Monthly payout",
  payeeNote: "Payroll settlement",
});

const status = await client.disbursement.getTransferStatus(referenceId);
console.log(status.status, status.financialTransactionId);
```

## Deposit (v2)

```ts
const depositRef = await client.disbursement.deposit({
  amount: "15000",
  currency: "UGX",
  payeeMsisdn: "256772123456",
  externalId: "dep-009",
});

const depositStatus = await client.disbursement.getDepositStatus(depositRef);
console.log(depositStatus.status);
```

## Refund (v2)

```ts
const refundRef = await client.disbursement.refund({
  amount: "5000",
  currency: "UGX",
  externalId: "refund-42",
  referenceIdToRefund: originalCollectionRef,
  payerMessage: "Order refund",
});

const refundStatus = await client.disbursement.getRefundStatus(refundRef);
console.log(refundStatus.status);
```

## Account balance & validation

```ts
const balance = await client.disbursement.getBalance();
const currencyBalance = await client.disbursement.getBalanceForCurrency("UGX");
const active = await client.disbursement.isAccountHolderActive("256772123456");
const profile = await client.disbursement.getBasicUserInfo("256772123456");
```
