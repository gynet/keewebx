import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

assert(process.argv[2], 'Usage: node scripts/check-extension-artifact.mjs <extracted-directory> [build-directory]');
const root = path.resolve(process.argv[2]);
const source = process.argv[3] && path.resolve(process.argv[3]);
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert([2, 3].includes(manifest.manifest_version));
assert(typeof manifest.version === 'string');
if (source) assert.deepEqual(manifest, JSON.parse(readFileSync(path.join(source, 'manifest.json'), 'utf8')));
const paths = new Set(['LICENSE', 'THIRD-PARTY-LICENSES.md']);
const icons = (value) => {
    if (typeof value === 'string') paths.add(value);
    else if (value) Object.values(value).forEach((file) => paths.add(file));
};
icons(manifest.icons);
for (const action of [manifest.action, manifest.browser_action, manifest.page_action]) {
    if (action?.default_popup) paths.add(action.default_popup);
    icons(action?.default_icon);
}
for (const file of [manifest.background?.page, manifest.background?.service_worker,
    manifest.options_ui?.page, manifest.options_page, manifest.side_panel?.default_path]) {
    if (file) paths.add(file);
}
for (const file of manifest.background?.scripts || []) paths.add(file);
for (const item of manifest.content_scripts || []) {
    [...(item.js || []), ...(item.css || [])].forEach((file) => paths.add(file));
}
if (manifest.default_locale) paths.add(`_locales/${manifest.default_locale}/messages.json`);
if (manifest.side_panel) {
    ['js/popup.js', 'js/settings.js', 'app/index.html', 'app/js/app.js',
        'app/js/argon2-worker.js', 'app/css/app.css'].forEach((file) => paths.add(file));
}
function files(directory, prefix = '') {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const rel = prefix + entry.name;
        return entry.isDirectory() ? files(path.join(directory, entry.name), rel + '/') : [rel];
    });
}
for (const item of manifest.web_accessible_resources || []) {
    for (const pattern of typeof item === 'string' ? [item] : item.resources || []) {
        const regex = new RegExp('^' + pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
        const matches = files(root).filter((file) => regex.test(file));
        assert(matches.length, `Empty resource pattern: ${pattern}`);
        matches.forEach((file) => paths.add(file));
    }
}
if (source) {
    // Include indirect HTML/CSS dependencies, not only manifest entry points.
    const built = files(source).sort();
    assert.deepEqual(files(root).sort(), built, 'Packaged file set differs from the build');
    built.forEach((file) => paths.add(file));
}
for (const file of paths) {
    const resolved = path.resolve(root, file);
    assert(resolved.startsWith(root + path.sep), `Invalid resource path: ${file}`);
    const stat = statSync(resolved);
    assert(stat.isFile() && stat.size, `Missing or empty resource: ${file}`);
    if (source) assert(readFileSync(resolved).equals(readFileSync(path.join(source, file))), `Different packaged resource: ${file}`);
}
console.log(JSON.stringify({ version: manifest.version, resourcesChecked: paths.size, passed: true }));
