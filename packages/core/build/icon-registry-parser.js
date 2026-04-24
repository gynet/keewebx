/**
 * Reads app/scripts/const/icon-registry.ts as text and extracts the
 * three icon lists (ENTRY_ICONS, APP_ICONS, FA_ICONS) for consumption
 * by webpack loaders.
 *
 * We parse the source file as text rather than `require`-ing it so
 * the build pipeline stays ESM/CJS-neutral and doesn't need ts-node.
 * The registry file is a pure data declaration; the regex below is
 * deliberately strict about its shape — any non-matching syntax
 * fails loudly, not silently.
 */

const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.resolve(
    __dirname,
    '..',
    'app/scripts/const/icon-registry.ts'
);

function extractList(source, listName) {
    const re = new RegExp(
        `export const ${listName} = \\[([\\s\\S]*?)\\] as const;`,
        'm'
    );
    const match = re.exec(source);
    if (!match) {
        throw new Error(
            `icon-registry.ts: could not find "export const ${listName} = [ ... ] as const;"`
        );
    }
    const items = [...match[1].matchAll(/['"]([a-zA-Z0-9-]+)['"]/g)].map(
        (m) => m[1]
    );
    if (items.length === 0) {
        throw new Error(`icon-registry.ts: ${listName} parsed to an empty list`);
    }
    const dupe = items.find((name, i) => items.indexOf(name) !== i);
    if (dupe) {
        throw new Error(`icon-registry.ts: duplicate icon "${dupe}" in ${listName}`);
    }
    return items;
}

function loadIconRegistry() {
    const source = fs.readFileSync(REGISTRY_PATH, 'utf8');
    const ENTRY_ICONS = extractList(source, 'ENTRY_ICONS');
    const APP_ICONS = extractList(source, 'APP_ICONS');

    // Sanity check: ENTRY_ICONS and APP_ICONS must not overlap —
    // each FA name owns exactly one role.
    const entrySet = new Set(ENTRY_ICONS);
    const overlap = APP_ICONS.filter((n) => entrySet.has(n));
    if (overlap.length > 0) {
        throw new Error(
            `icon-registry.ts: names appear in both ENTRY_ICONS and APP_ICONS: ${overlap.join(', ')}`
        );
    }

    return {
        ENTRY_ICONS,
        APP_ICONS,
        FA_ICONS: [...ENTRY_ICONS, ...APP_ICONS],
        registryPath: REGISTRY_PATH
    };
}

module.exports = { loadIconRegistry };
