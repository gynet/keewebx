import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const [label, destination] = process.argv.slice(2);
assert(label && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(label) && destination,
    'Usage: node scripts/package-web.mjs <version-label> <output-directory>');
const output = path.resolve(destination);
const dist = path.resolve('dist');
assert(!output.startsWith(dist + path.sep) && output !== dist, 'Output must be outside dist');
const required = ['index.html', 'classic.html', 'classic/index.html', 'next.html', 'js/app.js',
    'js/next.js', 'css/app.css', 'css/next.css', 'service-worker.js', 'manifest.json',
    'manifest-classic.json', 'manifest-new.json', 'LICENSE', 'THIRD-PARTY-LICENSES.md'];
for (const file of required) assert(readFileSync(path.join(dist, file)).length, `Missing/empty ${file}`);

// Recompile each standalone worker from the current source, retaining the
// shared cache logic while limiting precaching to assets in that package.
const require = createRequire(path.resolve('modules/ui-classic/webpack.config.js'));
const webpack = require('webpack');
const workerSource = readFileSync('modules/ui-classic/app/sw/shell-cache.ts', 'utf8');
const shellDeclaration = /export const SHELL_ASSETS = (\[[\s\S]*?\]);/;
const shellMatch = workerSource.match(shellDeclaration);
assert(shellMatch, 'Cannot locate the worker shell manifest');
const shellAssets = [...shellMatch[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
assert(shellAssets.includes('index.html') && shellAssets.includes('js/app.js') && shellAssets.includes('js/next.js'),
    'Unexpected worker shell manifest');
for (const file of shellAssets) assert(existsSync(path.join(dist, file)), `Missing shell asset: ${file}`);

async function buildWorker(stage, ui, excluded) {
    const generated = path.join(output, 'staging', `.shell-cache-${ui}.ts`);
    const source = workerSource.replace(shellDeclaration,
        `export const SHELL_ASSETS = ${JSON.stringify(shellAssets.filter(file => !excluded.has(file)))};`)
        .replace("export const CACHE_PREFIX = 'keewebx-shell-';",
            `export const CACHE_PREFIX = 'keewebx-shell-${ui}-';`);
    // Separate cache namespaces also avoid refreshing removed UI pages when
    // replacing a combined deployment with a standalone package at one origin.
    assert(source.includes(`keewebx-shell-${ui}-`), 'Cannot isolate the package worker cache');
    writeFileSync(generated, source);
    const config = require('./webpack.config.js')({}, { mode: 'production' });
    config.entry = { 'service-worker': config.entry['service-worker'] };
    assert(config.entry['service-worker'], 'Offline builds are required for release packaging');
    config.output = { ...config.output, path: stage, clean: false };
    config.module.rules = [{ test: /\.ts$/, use: { loader: require.resolve('ts-loader'), options: {
        configFile: path.resolve('modules/ui-classic/app/sw/tsconfig.json'),
        onlyCompileBundledFiles: true, compilerOptions: { noEmit: false }
    } } }];
    config.plugins = config.plugins.filter(plugin => plugin instanceof webpack.DefinePlugin || plugin instanceof webpack.BannerPlugin);
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(/^\.\/shell-cache$/, resource => {
        resource.request = generated;
    }));
    try {
        await new Promise((resolve, reject) => {
            const compiler = webpack(config);
            compiler.run((error, stats) => compiler.close(closeError => {
                if (error || closeError) reject(error || closeError);
                else if (stats.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })));
                else resolve();
            }));
        });
    } finally {
        rmSync(generated, { force: true });
    }
}

const packages = [];
for (const ui of ['new', 'classic', 'combined']) {
    const base = `keewebx-${ui === 'combined' ? 'web' : ui}-${label}`;
    const stage = path.join(output, 'staging', base);
    assert(!existsSync(stage), `Staging directory already exists: ${stage}`);
    for (const ext of ['zip', 'tar.gz']) assert(!existsSync(path.join(output, `${base}.${ext}`)), `Archive already exists: ${base}.${ext}`);
    mkdirSync(stage, { recursive: true });
    cpSync(dist, stage, { recursive: true });
    cpSync('docs/self-host.md', path.join(stage, 'DEPLOY.md'));
    if (ui !== 'combined') {
        const excluded = new Set(ui === 'new'
            ? ['classic.html', 'classic/index.html', 'manifest-classic.json', 'js/app.js', 'css/app.css']
            : ['next.html', 'manifest-new.json', 'js/next.js', 'css/next.css']);
        for (const file of [...excluded]) {
            if (/\.(js|css)$/.test(file)) for (const suffix of ['.map', '.LICENSE.txt']) excluded.add(file + suffix);
        }
        for (const file of excluded) rmSync(path.join(stage, file), { force: true });
        if (ui === 'new') rmSync(path.join(stage, 'classic'), { recursive: true, force: true });
        else {
            cpSync(path.join(stage, 'classic.html'), path.join(stage, 'index.html'));
            const manifest = JSON.parse(readFileSync(path.join(stage, 'manifest-classic.json'), 'utf8'));
            writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ ...manifest, id: './', start_url: './index.html' }));
        }
        const htmlFiles = ui === 'new' ? ['index.html', 'next.html'] : ['index.html', 'classic.html', 'classic/index.html'];
        for (const file of htmlFiles) {
            const htmlPath = path.join(stage, file);
            const html = readFileSync(htmlPath, 'utf8');
            assert(html.includes('<head'), `Missing head in ${file}`);
            writeFileSync(htmlPath, html.replace(/(<head[^>]*>)/, `$1<meta name="kw-interface" content="${ui}">`));
        }
        await buildWorker(stage, ui, excluded);
    }
    writeFileSync(path.join(stage, 'WEB-PACKAGE.json'), JSON.stringify({
        schemaVersion: 1, interface: ui, entry: 'index.html', deprecated: ui === 'classic'
    }, null, 2) + '\n');
    execFileSync('zip', ['-rq', path.join(output, `${base}.zip`), base], { cwd: path.dirname(stage) });
    execFileSync('tar', ['-czf', path.join(output, `${base}.tar.gz`), base], { cwd: path.dirname(stage) });
    for (const ext of ['zip', 'tar.gz']) {
        const file = `${base}.${ext}`;
        const hash = createHash('sha256').update(readFileSync(path.join(output, file))).digest('hex');
        writeFileSync(path.join(output, `${file}.sha256`), `${hash}  ${file}\n`);
    }
    packages.push({ base, interface: ui });
}
console.log(JSON.stringify({ output, packages }));
