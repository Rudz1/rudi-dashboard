# Research

Two private maps, kept apart. This page is not linked from the dashboard and it is not indexed. Lizzie and Heather each have their own encrypted file. There is no merged view: opening a tab loads only that file and shows only that graph.

| Tab | Encrypted file |
| --- | --- |
| Lizzie | `data.enc.json` |
| Heather | `data-heather.enc.json` |

`data-heather.enc.json` is produced with the same encrypt tool and the same format as `data.enc.json`. Only the output filename changes.

That tool is the one `crypto.js` stays in lockstep with (`tools/encrypt.py`): AES-256-GCM, PBKDF2-HMAC-SHA256, 600000 iterations, a 16-byte salt and a 12-byte IV. The JSON file has `v`, `alg`, `kdf`, `iter`, `salt`, `iv` and `ct`. Point the tool at `research/data-heather.enc.json` instead of `research/data.enc.json`.

The passphrase is typed once per visit and kept in memory only. The last-opened tab is the URL hash, `#lizzie` or `#heather`.
