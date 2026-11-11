# @keewebx/vault

The part of KeeWebX that has no user interface: vault and entry models,
storage (WebDAV, the local cache), sync, settings, and the API the browser
extension uses. Both interfaces build on it.

Code here imports by folder name (`models/…`, `storage/…`, `util/…`). An app
that bundles it resolves those names in its own source folder first and in
`src/` here second, so an app can provide its own version of a module.

Rules:

- No interface code: no views, templates, DOM widgets or jQuery. Code that
  needs the user to answer or see something emits an event or takes a
  callback, and the interface handles it.
- Stored formats only gain fields, so every interface keeps reading them.
