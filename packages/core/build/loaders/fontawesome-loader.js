const fs = require('fs');
const path = require('path');

const SVGIcons2SVGFontStream = require('svgicons2svgfont');
const svg2ttf = require('svg2ttf');
const wawoff2 = require('wawoff2');

const { loadIconRegistry } = require('../icon-registry-parser');

const faDir = path.dirname(require.resolve('@fortawesome/fontawesome-free/package.json'));
const svgBaseDir = path.join(faDir, 'svgs');
const svgDirs = ['brands', 'regular', 'solid']
    .map((dir) => path.join(svgBaseDir, dir))
    .concat('graphics/svg');

const allIcons = {};

for (const svgDir of svgDirs) {
    const suffix = svgDir.endsWith('regular') ? '-o' : '';
    fs.readdirSync(path.join(svgDir))
        .filter((icon) => icon.endsWith('.svg'))
        .forEach((icon) => {
            const svgIconPath = path.join(svgDir, icon);
            const iconName = icon.substr(0, icon.length - 4) + suffix;
            allIcons[iconName] = svgIconPath;
        });
}

module.exports = function makeFontAwesomeWoff2() {
    const callback = this.async();
    if (this.cacheable) {
        this.cacheable();
    }

    try {
        const { FA_ICONS, registryPath } = loadIconRegistry();
        this.addDependency(registryPath);

        process.stdout.write('Building fontawesome.woff2... ');
        const startTime = Date.now();

        buildFont(this, FA_ICONS).then(
            ({ fontData, iconsCount }) => {
                const kb = (fontData.byteLength / 1024).toFixed(2);
                const time = Date.now() - startTime;
                process.stdout.write(`ok: ${time}ms, ${iconsCount} icons, ${kb} KiB\n`);
                const fontCss = fontData.toString('base64');
                callback(null, `module.exports = "data:font/woff2;base64,${fontCss}"`);
            },
            (ex) => {
                process.stdout.write('error\n');
                callback(ex);
            }
        );
    } catch (ex) {
        callback(ex);
    }
};

function buildFont(loader, iconList) {
    // Validate up front so missing icons produce a clear error, not
    // a cryptic stream failure half-way through font generation.
    const missing = iconList.filter((name) => !allIcons[name]);
    if (missing.length > 0) {
        return Promise.reject(
            new Error(
                `Font Awesome icons not found in @fortawesome/fontawesome-free: ${missing.join(', ')}`
            )
        );
    }

    const fontStream = new SVGIcons2SVGFontStream({
        fontName: 'Font Awesome 5 Free',
        round: 10e12,
        log() {}
    });

    const fontData = [];
    fontStream.on('data', (chunk) => fontData.push(chunk));

    let charCode = 0xf000;
    for (const iconName of iconList) {
        ++charCode;
        const svgIconPath = allIcons[iconName];
        loader.addDependency(svgIconPath);

        const glyph = fs.createReadStream(svgIconPath);
        glyph.metadata = { name: iconName, unicode: [String.fromCharCode(charCode)] };

        fontStream.write(glyph);
    }
    fontStream.end();

    return new Promise((resolve, reject) => {
        fontStream.on('end', async () => {
            try {
                let data = Buffer.concat(fontData);
                data = Buffer.from(svg2ttf(data.toString('utf8')).buffer);
                data = Buffer.from(await wawoff2.compress(data));

                resolve({ fontData: data, iconsCount: iconList.length });
            } catch (ex) {
                reject(ex);
            }
        });
    });
}

module.exports.raw = true;
