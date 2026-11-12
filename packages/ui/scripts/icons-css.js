// Entry icons use the Classic app's icon font, which its build inlines into
// css/app.css. Copy the font and the glyph rules into css/icons.css for the
// new interface. Runs after both builds.
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '../../core/dist');
const appCss = fs.readFileSync(path.join(dist, 'css/app.css'), 'utf8');
const fontFace = appCss.match(/@font-face\{font-family:"Font Awesome 5 Free"[^}]*\}/)?.[0];
const glyphs = appCss.match(/\.fa-[a-z0-9-]+:before\{content:"[^"]*"\}/g) ?? [];
if (!fontFace || glyphs.length < 50) {
    throw new Error('Icon font not found in css/app.css');
}
fs.writeFileSync(
    path.join(dist, 'css/icons.css'),
    [
        fontFace,
        '.fa{font-family:"Font Awesome 5 Free";font-weight:400;font-style:normal;-webkit-font-smoothing:antialiased;display:inline-block;line-height:1}',
        ...glyphs
    ].join('\n') + '\n'
);
console.log('wrote css/icons.css');
