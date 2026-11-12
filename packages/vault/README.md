# Shared vault services

Both web interfaces and the extension reuse this package's models, storage
adapters, synchronization, settings, crypto helpers and extension API.
The KDBX format implementation lives in `../db`.

`src/` contains application services and browser platform helpers;
`resources/` contains the shared demonstration database and public signing keys.
This package must not import either UI, their styles or `../ui-kit`.

The root build checks these boundaries before compiling either interface.
