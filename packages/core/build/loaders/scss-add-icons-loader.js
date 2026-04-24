const { loadIconRegistry } = require('../icon-registry-parser');

/**
 * Injects the icon font variables + class rules into the top-level
 * SCSS entry. Webpack only runs this loader on the SCSS file it
 * resolves directly (main.scss). `@import`-ed partials are handled by
 * sass-loader internally and do not pass through this loader.
 *
 * Two blocks:
 *   - `$fa-var-NAME: "\fXXXX";` declarations — prepended so they are
 *     defined before any `@import` that uses them (e.g. _forms.scss
 *     references `$fa-var-square-o`). Codepoints follow icon-registry
 *     order and match what fontawesome-loader burns into the woff2.
 *   - `.fa-NAME:before { content: $fa-var-NAME; }` rules — appended
 *     so the final compiled CSS has one rule per registered icon.
 */

function buildBlocks() {
    const { FA_ICONS } = loadIconRegistry();

    const varDecls = FA_ICONS.map((name, index) => {
        const codepoint = (0xf000 + index + 1)
            .toString(16)
            .padStart(4, '0');
        return `$fa-var-${name}: "\\${codepoint}";`;
    });

    const classRules = FA_ICONS.map(
        (name) => `.fa-${name}:before { content: $fa-var-${name}; }`
    );

    return {
        prepend: varDecls.join('\n') + '\n',
        append: '\n' + classRules.join('\n') + '\n'
    };
}

module.exports = function loadScss(scssSource) {
    this.addDependency(require.resolve('../icon-registry-parser'));
    const { prepend, append } = buildBlocks();
    return prepend + scssSource + append;
};
