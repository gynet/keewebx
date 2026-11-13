import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const [label, destination] = process.argv.slice(2);
assert(label && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(label) && destination,
    'Usage: node scripts/package-web.mjs <version-label> <output-directory>');
const base = `keewebx-web-${label}`;
const output = path.resolve(destination);
const stage = path.join(output, 'staging', base);
assert(!existsSync(stage), `Staging directory already exists: ${stage}`);
const required = ['index.html', 'classic.html', 'classic/index.html', 'next.html', 'js/app.js',
    'js/next.js', 'css/app.css', 'css/next.css', 'service-worker.js', 'manifest.json',
    'manifest-classic.json', 'manifest-new.json', 'LICENSE', 'THIRD-PARTY-LICENSES.md'];
for (const file of required) assert(readFileSync(path.join('dist', file)).length, `Missing/empty ${file}`);
mkdirSync(stage, { recursive: true });
cpSync('dist', stage, { recursive: true });
cpSync('docs/self-host.md', path.join(stage, 'DEPLOY.md'));
execFileSync('zip', ['-rq', path.join(output, `${base}.zip`), base], { cwd: path.dirname(stage) });
execFileSync('tar', ['-czf', path.join(output, `${base}.tar.gz`), base], { cwd: path.dirname(stage) });
for (const ext of ['zip', 'tar.gz']) {
    const file = `${base}.${ext}`;
    const hash = createHash('sha256').update(readFileSync(path.join(output, file))).digest('hex');
    writeFileSync(path.join(output, `${file}.sha256`), `${hash}  ${file}\n`);
}
console.log(JSON.stringify({ base, output, requiredFiles: required.length }));
