import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const result = await Bun.build({
    entrypoints: [path.join(import.meta.dir, 'src/simple-connect.ts')],
    target: 'browser', format: 'iife', minify: true, sourcemap: 'none',
    plugins: [{ name: 'browser-crypto-only', setup(build) {
        // Match the extension webpack browser build: TweetNaCl uses the secure
        // browser CSPRNG, never a large Node crypto/browserify fallback.
        build.onResolve({ filter: /^(node:)?crypto$/ }, () => ({ path: 'crypto', namespace: 'browser-only' }));
        build.onLoad({ filter: /.*/, namespace: 'browser-only' }, () => ({ contents: 'export default {};', loader: 'js' }));
    } }]
});
if (!result.success) throw new AggregateError(result.logs, 'Userscripts Connect build failed');
const license = await readFile(path.join(import.meta.dir, '../../..', 'LICENSE'), 'utf8');
const metadata = `// ==UserScript==
// @name         KeeWebX Connect (experimental)
// @namespace    https://keewebx.app/
// @version      0.5.4
// @description  Authorize KeeWebX once and fill accounts on all websites using the existing encrypted Connect protocol. Experimental iOS Safari support.
// @match        https://*/*
// @noframes
// @run-at       document-idle
// @inject-into  content
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.listValues
// @grant        GM.getTab
// @grant        GM.saveTab
// ==/UserScript==

// Native window messages carry encrypted Connect payloads; a signed private mailbox recovers lost window associations.
/*! KeeWebX license:\n${license}\n*/
`;
const output = `${metadata}\n${(await result.outputs[0].text()).trimEnd()}\n`;
await writeFile(path.join(import.meta.dir, 'keewebx-connect.user.js'), output);
console.log(`Built keewebx-connect.user.js (${Buffer.byteLength(output)} bytes)`);
