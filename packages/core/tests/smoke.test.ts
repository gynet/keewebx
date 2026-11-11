import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const rootDir = path.join(__dirname, '..');
const scriptsDir = path.join(rootDir, 'app/scripts');
const vaultDir = path.join(rootDir, '../vault/src');

describe('core package smoke tests', () => {
    test('entry point app.ts exists', () => {
        const entryPath = path.join(scriptsDir, 'app.ts');
        expect(fs.existsSync(entryPath)).toBe(true);
    });

    test('index.html template exists', () => {
        const htmlPath = path.join(rootDir, 'app/index.html');
        expect(fs.existsSync(htmlPath)).toBe(true);
    });

    test('webpack.config.js exists and is valid JS', () => {
        const configPath = path.join(rootDir, 'webpack.config.js');
        expect(fs.existsSync(configPath)).toBe(true);
        const content = fs.readFileSync(configPath, 'utf-8');
        // Verify key structural elements are present
        expect(content).toContain("entry:");
        expect(content).toContain("app/scripts/app.ts");
        expect(content).toContain("module.exports");
        expect(content).toContain("devServer:");
    });

    test('tsconfig.json exists and is valid JSON', () => {
        const tsconfigPath = path.join(rootDir, 'tsconfig.json');
        expect(fs.existsSync(tsconfigPath)).toBe(true);
        const content = fs.readFileSync(tsconfigPath, 'utf-8');
        const parsed = JSON.parse(content);
        expect(parsed.compilerOptions.strict).toBe(true);
        expect(parsed.compilerOptions.allowJs).toBe(true);
        expect(parsed.compilerOptions.target).toBe('ES2020');
    });

    test('interface and vault folders exist', () => {
        for (const dir of ['comp', 'views', 'util', 'framework', 'hbs-helpers', 'presenters']) {
            expect(fs.existsSync(path.join(scriptsDir, dir))).toBe(true);
        }
        for (const dir of ['comp', 'models', 'util', 'storage', 'framework', 'const', 'collections', 'hooks', 'locales']) {
            expect(fs.existsSync(path.join(vaultDir, dir))).toBe(true);
        }
    });

    test('the vault package has no interface code', () => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) {
                    walk(p);
                } else if (p.endsWith('.ts')) {
                    const src = fs.readFileSync(p, 'utf8');
                    if (/from '(views|templates|presenters|hbs-helpers|comp\/ui)\/|from 'jquery'|from 'handlebars'/.test(src)) {
                        offenders.push(path.relative(vaultDir, p));
                    }
                }
            }
        };
        walk(vaultDir);
        expect(offenders).toEqual([]);
    });

    test('templates directory exists', () => {
        const templatesDir = path.join(rootDir, 'app/templates');
        expect(fs.existsSync(templatesDir)).toBe(true);
    });

    test('webpack resolves the app folder first, then the vault package', () => {
        const content = fs.readFileSync(
            path.join(rootDir, 'webpack.config.js'),
            'utf-8'
        );
        const app = content.indexOf("path.join(rootDir, 'app/scripts'),");
        const vault = content.indexOf("path.join(rootDir, '../vault/src'),");
        expect(app).toBeGreaterThan(0);
        expect(vault).toBeGreaterThan(app);
        expect(content).toContain("views: path.join(rootDir, 'app/scripts/views')");
        expect(content).toContain("templates: path.join(rootDir, 'app/templates')");
    });

    test('postcss config exists', () => {
        const postcssPath = path.join(rootDir, 'postcss.config.js');
        expect(fs.existsSync(postcssPath)).toBe(true);
    });
});
