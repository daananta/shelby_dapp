# Access policy used by Tạo RAG

`BlobMetadata` of Shelby SDK does not contain the product-level tags. This app reads them from the configured on-chain access-control module:

```text
{VITE_ACCESS_CONTROL_MODULE_ADDRESS}::access_control::query3_bcs
```

The app includes a testnet default. Set `VITE_ACCESS_CONTROL_MODULE_ADDRESS` whenever the access-control contract is deployed at a different address or network.

For each Shelby blob, the app constructs `@{owner-padded-to-64-hex}/{blobNameSuffix}`, calls `query3_bcs(owner, fullBlobName)`, and parses its BCS result. It recognizes:

- no metadata → `public`;
- policy 0 → `allowlist`, with `canAccess` from the contract;
- policy 1 → `timelock`, with `lockedUntilMicros` and `canAccess`;
- policy 2 → `purchasable`, with price and `canAccess`;
- custom/invalid/query failure → access is unknown and the RAG pipeline fails closed.

`Tạo RAG` only downloads a restricted blob after this query has returned `canAccess: true`. A timelock is also checked locally against `lockedUntilMicros`. Purchasable blobs render **Mua quyền**; the user must explicitly approve `init_new_buyer` (if necessary) and `purchase(fullBlobName)` in their wallet, after which the policy is queried again.

The contract policy controls this application's indexing decisions. It does not itself prove that raw bytes are encrypted: production confidentiality still requires an end-to-end GreenBox/decryption gateway or equivalent encryption layer before serving bytes. Keep OCR/embedding local for sensitive documents, and only send document data to cloud services after explicit owner consent.
