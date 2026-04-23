import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const rootDir = path.join(__dirname, '..');
const scriptsDir = path.join(rootDir, 'app/scripts');

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

    test('key module directories exist', () => {
        const dirs = [
            'comp', 'models', 'views', 'util', 'storage',
            'framework', 'const', 'collections', 'hbs-helpers'
        ];
        for (const dir of dirs) {
            const dirPath = path.join(scriptsDir, dir);
            expect(fs.existsSync(dirPath)).toBe(true);
        }
    });

    test('templates directory exists', () => {
        const templatesDir = path.join(rootDir, 'app/templates');
        expect(fs.existsSync(templatesDir)).toBe(true);
    });

    test('webpack config has correct alias mappings', () => {
        const content = fs.readFileSync(
            path.join(rootDir, 'webpack.config.js'),
            'utf-8'
        );
        // Verify aliases for key module directories
        expect(content).toContain("comp: path.join(rootDir, 'app/scripts/comp')");
        expect(content).toContain("models: path.join(rootDir, 'app/scripts/models')");
        expect(content).toContain("views: path.join(rootDir, 'app/scripts/views')");
        expect(content).toContain("framework: path.join(rootDir, 'app/scripts/framework')");
        expect(content).toContain("templates: path.join(rootDir, 'app/templates')");
    });

    test('postcss config exists', () => {
        const postcssPath = path.join(rootDir, 'postcss.config.js');
        expect(fs.existsSync(postcssPath)).toBe(true);
    });
});
