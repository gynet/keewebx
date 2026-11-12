# KeeWeb Connect protocol

The protocol is designed to be backward-compatible with [keepassxc-protocol](https://github.com/keepassxreboot/keepassxc-browser/blob/develop/keepassxc-protocol.md).

This way KeeWeb can connect to both KeePassXC-browser and KeeWeb.
Integration with KeeWeb Connect is more native to KeeWeb
because it works well with several databases open at the same time.

However, KeeWeb Connect extension will work only with KeeWeb
because it's relying on our additions.


## Overall differences

Extensions cannot save database ID safely. This means that KeeWeb will present a question
every time an extension is trying to connect.

This way you connect to KeeWeb instead of a particular database, 
and the user can choose what exactly to share when it comes to sharing credentials.

## List of modifications

### `ping`

This message is to verify that the connection is alive without running any logic.

Request:
```json
{
    "action": "ping",
    "data": "<random string>"
}
```

Response:
```json
{
    "data": "<the same random string>"
}
```

### `change-public-keys`

To be able to identify the app and extension, response and request are extended with additional fields:

Request:
```diff
{
    "action": "change-public-keys",
+    "extensionName": "KeeWeb Connect",
+    "version": "1.0",
    "publicKey": "<client public key>",
    "nonce": "34e5d6t7gy8jok",
    "clientID": "<clientID>"
}
```

Response:
```diff
{
    "action": "change-public-keys",
+    "appName": "KeeWeb",
    "version": "1.2.3",
    "publicKey": "<host public key>",
    "success": "true"
}
```

### `get-databasehash`

`hash` is always set to `sha256('KeeWeb')`.

### `associate`

This is a no-op, it won't store anything in the file.
It will always return `KeeWeb` as a database ID and the same hash.

### `test-associate`

Always returns success assuming the client is authenticated and there's an open file.

### `generate-password`

Same contract, but passwords will be generated even if there's no open database.

### `get-totp-by-url`

Returns TOTP by url, similar to `get-logins`.

Unencrypted message:
```json
{
    "action": "get-totp-by-url",
    "url": "<url>",
    "title": "<page-title>"
}
```

Decrypted response:
```json
{
    "totp": "<TOTP>",
    "version": "1.2.3",
    "success": "true"
}
```

### `get-any-field`

Allows user to select a field, similar to `get-logins`.

Unencrypted message:
```json
{
    "action": "get-any-field",
    "url": "<url>",
    "title": "<page-title>"
}
```

Decrypted response:
```json
{
    "field": "<field-name>",
    "value": "<field-value>",
    "version": "1.2.3",
    "success": "true"
}
```

### `attention-required`

Event emitted by KeeWeb when its own tab needs user attention, for example, to approve a connection request.
The extension must focus the tab with KeeWeb when it receives this event, because a browser tab cannot focus itself.
Desktop apps never send this event.

```json
{
    "action": "attention-required"
}
```

## KeeWebX additions

These requests let the KeeWebX extension show a list of logins in its popup
when KeeWebX runs in a browser tab. They are added alongside the existing
ones; older apps answer "Handler not found" and the extension falls back to
the requests above. All of them are encrypted like any other request.

### Security model

- **Pairing.** The extension keeps a long-term ed25519 identity key in its
  own storage. On each connection it signs the two box public keys of that
  session. The app stores what the user approved for that identity key, so a
  different client cannot reuse the approval. Clients that do not pair keep
  the shared approval they had before.
- **Listing needs its own approval.** The approval dialog has a separate
  "list and search entries" option, offered only to a paired client. An
  unpaired client can never list.
- **No secrets in lists.** Lists carry title, username, website and icon.
  Each entry comes with a random handle, valid for 5 minutes, for that
  client only, and cleared when the app locks. Fields, including the
  password, are read one entry at a time by handle, after the user picks it.
  Each password read is counted in the app's extension sessions.

### `kwx-pair`

Request payload:
```json
{
    "action": "kwx-pair",
    "identityKey": "<base64 ed25519 public key>",
    "signature": "<base64 detached signature of 'kwx-pair-v1' || extension box public key || app box public key>"
}
```

Decrypted response: `{ "success": "true", "known": true }`. `known` says
whether the app already stores an approval for this key.

### `kwx-features`

Decrypted response:
```json
{
    "features": ["entries-v1"],
    "locked": false,
    "paired": true,
    "canList": true
}
```

### `kwx-get-entries`

Request payload: `{ "action": "kwx-get-entries", "url": "<page url, optional>", "query": "<search text, optional>" }`.
When the app is locked it answers `{ "locked": true, "suggested": [], "items": [] }`
without asking anything. Otherwise the first request may show the approval
dialog in the app tab (with `attention-required`).

Decrypted response:
```json
{
    "locked": false,
    "suggested": [{ "handle": "<base64>", "title": "GitHub", "user": "demouser", "url": "github.com", "icon": "globe", "customIcon": null, "hasOtp": true }],
    "items": []
}
```

`suggested` holds logins for `url` (none while searching). `items` holds the
30 most recently changed entries, or up to 50 search results.

### `kwx-get-entry-fields`

Request payload: `{ "action": "kwx-get-entry-fields", "handle": "<base64>", "fields": ["user", "password", "otp", "url"] }`.

Decrypted response: `{ "values": { "user": "demouser", "password": "..." } }`.
An unknown, expired or foreign handle fails with error code `kwx-expired-handle`.
