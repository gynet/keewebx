/**
 * Builds the prototype extension that carries the whole KeeWebX app, so no
 * separate app tab or website is needed. Output: dist/chrome-vault.
 * Requires a production build of packages/ui-classic (`bun run build` at the root).
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { buildArgon2WorkerSource } from '../../vault/src/util/kdbxweb/argon2-worker-source';

const root = path.resolve(__dirname, '..');
const coreDist = path.join(root, '../../dist');
const out = path.join(root, 'dist/chrome-vault');
const appDir = path.join(out, 'app');

if (!fs.existsSync(path.join(coreDist, 'js/app.js'))) {
    throw new Error('dist is missing: run `bun run build` at the repo root first');
}

const build = spawnSync('bunx', ['webpack', '--mode=production'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, KW_BROWSER: 'chrome', KW_VAULT: '1' }
});
if (build.status !== 0) {
    process.exit(build.status ?? 1);
}

fs.rmSync(appDir, { recursive: true, force: true });
fs.cpSync(coreDist, appDir, {
    recursive: true,
    // The extension package itself provides offline use.
    filter: (src) => !path.basename(src).startsWith('service-worker')
});

const loader = require.resolve('hash-wasm/dist/argon2.umd.min.js', { paths: [path.join(root, '../ui-classic')] });
fs.writeFileSync(
    path.join(appDir, 'js/argon2-worker.js'),
    buildArgon2WorkerSource(fs.readFileSync(loader, 'utf8'))
);

// Extension pages cannot use eval. The only call in the bundle is the baron
// scrollbar library looking up the global object.
const appJsPath = path.join(appDir, 'js/app.js');
const appJs = fs.readFileSync(appJsPath, 'utf8');
const evalCall = '(0,eval)("this")';
if (appJs.split(evalCall).length !== 2) {
    throw new Error(`Expected exactly one ${evalCall} in app.js`);
}
fs.writeFileSync(appJsPath, appJs.replace(evalCall, 'globalThis'));

// The page talks to the extension through the same bridge script that gets
// injected into website tabs.
const indexPath = path.join(appDir, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');
const appScript = /<script src="js\/app\.js[^"]*"><\/script>/;
if (!appScript.test(html)) {
    throw new Error('app.js script tag not found in index.html');
}
fs.writeFileSync(
    indexPath,
    html.replace(appScript, (tag) => `<script src="../js/content-keeweb.js"></script>${tag}`)
);

// Entry icons in the popup use the app's icon font, which the app build
// inlines into its stylesheet.
const appCss = fs.readFileSync(path.join(appDir, 'css/app.css'), 'utf8');
const fontFace = appCss.match(/@font-face\{font-family:"Font Awesome 5 Free"[^}]*\}/)?.[0];
const glyphs = appCss.match(/\.fa-[a-z0-9-]+:before\{content:"[^"]*"\}/g) ?? [];
if (!fontFace || glyphs.length < 50) {
    throw new Error('Icon font not found in app.css');
}
fs.writeFileSync(
    path.join(out, 'styles/icons.css'),
    [
        fontFace,
        '.fa{font-family:"Font Awesome 5 Free";font-weight:400;font-style:normal;-webkit-font-smoothing:antialiased;display:inline-block;line-height:1}',
        ...glyphs
    ].join('\n') + '\n'
);

console.log(`Built ${path.relative(process.cwd(), out)}`);
