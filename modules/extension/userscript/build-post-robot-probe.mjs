import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const base = new URL('./', import.meta.url);
const library = await readFile(new URL('vendor/post-robot-11.0.1.min.js', base), 'utf8');
const expected = '7cc512fa9e25f4abcc30b199bcf96c6bc9683fd32d62db9f72c06a52fc50ff54';
if (createHash('sha256').update(library).digest('hex') !== expected) {
    throw new Error('Vendored post-robot distribution does not match the pinned SHA-256');
}
const source = await readFile(new URL('src/post-robot-probe.js', base), 'utf8');
const license = await readFile(new URL('vendor/post-robot-LICENSE', base), 'utf8');
if (createHash('sha256').update(license).digest('hex') !== 'b91dceb7942fcaa506877374cb07a600cb739b5bac8ecb35e455a831346d6104') {
    throw new Error('Vendored post-robot license does not match the pinned distribution');
}
const metadata = `// ==UserScript==
// @name         KeeWebX post-robot connection test
// @namespace    https://keewebx.app/
// @version      0.2.0
// @description  Test cross-origin replies from the original KeeWebX tab using bundled post-robot 11.0.1. No database/password access.
// @match        https://*/*
// @noframes
// @run-at       document-idle
// @inject-into  content
// @grant        none
// ==/UserScript==

// Includes @krakenjs/post-robot 11.0.1, Apache-2.0.
// Source: https://github.com/krakenjs/post-robot
// License: https://github.com/krakenjs/post-robot/blob/main/LICENSE
// Distribution SHA-256: ${expected}
`;
// Retain the original vendored bytes separately, but omit the relative source
// map URL from the standalone install artifact. No runtime CDN imports.
const bundledLibrary = library.replace(/\/\/# sourceMappingURL=[^\r\n]*/g, '');
const output = `${metadata}\n/*! @krakenjs/post-robot 11.0.1 license:\n${license}\n*/\n(() => {\nconst module = { exports: {} };\nconst exports = module.exports;\n${bundledLibrary}\n${source}\ninstallKeeWebXPostRobotProbe(module.exports);\n})();\n`;
await writeFile(new URL('diagnostics/post-robot-probe.user.js', base), output);
console.log(`Built post-robot-probe.user.js (${Buffer.byteLength(output)} bytes)`);
