const fs = require('fs');
const path = require('path');

module.exports = function loadScss(scssSource) {
    const callback = this.async();

    const coreRoot = path.resolve(__dirname, '../..');
    const iconFontScssPath = path.join(coreRoot, 'app/styles/base/_icon-font.scss');

    this.addDependency(iconFontScssPath);

    fs.readFile(iconFontScssPath, 'utf-8', (err, iconFontScssSource) => {
        if (err) {
            return callback(err);
        }
        scssSource +=
            '\n' +
            [...iconFontScssSource.matchAll(/\n\$fa-var-([\w-]+):/g)]
                .map(([, name]) => name)
                .map((icon) => `.fa-${icon}:before { content: $fa-var-${icon}; }`)
                .join('\n');
        callback(null, scssSource);
    });
};
