import { test, expect } from 'bun:test';
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { resolveUiLocale, uiDictionaries, interpolate } from '../src/locale-data';
import german from '../src/locales/de-DE.json';
import french from '../src/locales/fr-FR.json';
import { keyboardShortcuts } from '../src/keyboard-shortcuts';
import { palettes, palettePairs } from '../src/palettes';

test('locale choice respects explicit settings, browser order and unsupported fallback', () => {
    expect(resolveUiLocale('en-US', ['de-DE'])).toBe('en-US');
    expect(resolveUiLocale('fr-CA', ['de-DE'])).toBe('fr-FR');
    expect(resolveUiLocale('de', ['en'])).toBe('de-DE');
    expect(resolveUiLocale(null, ['es-ES', 'fr-CA', 'de-DE'])).toBe('fr-FR');
    expect(resolveUiLocale(undefined, ['en-GB', 'de-DE'])).toBe('en-US');
    expect(resolveUiLocale('unsupported', ['fr-FR'])).toBe('en-US');
    expect(resolveUiLocale(null, [])).toBe('en-US');
    expect(resolveUiLocale(null, undefined)).toBe('en-US');
});
test('interpolation preserves values literally without treating them as templates', () => {
    expect(interpolate('{} / {}', ['$& {} <script>', 'Password'])).toBe('$& {} <script> / Password');
    expect(interpolate('{} {} {}', ['x', ''])).toBe('x  {}');
    expect(interpolate('plain', ['ignored'])).toBe('plain');
});
test('German and French catalogs match and preserve all placeholders', () => {
    expect(Object.keys(german).sort()).toEqual(Object.keys(french).sort());
    for (const dictionary of [german, french]) for (const [key, value] of Object.entries(dictionary)) {
        expect(value.trim(), key).not.toBe('');
        expect(value.match(/\{\}/g)?.length ?? 0, key).toBe(key.match(/\{\}/g)?.length ?? 0);
    }
});
test('visible literal UI strings, preference labels and palette names have translations', () => {
    const keys = new Set<string>();
    const collect = (node: ts.Node) => {
        if (ts.isStringLiteralLike(node)) keys.add(node.text);
        else if (ts.isConditionalExpression(node)) { collect(node.whenTrue); collect(node.whenFalse); }
        else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) collect(node.right);
    };
    const root = new URL('../src/', import.meta.url);
    for (const name of readdirSync(root).filter(name => /\.tsx?$/.test(name))) {
        const source = ts.createSourceFile(name, readFileSync(new URL(name, root), 'utf8'), ts.ScriptTarget.Latest, true);
        const walk = (node: ts.Node) => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't' && node.arguments[0]) collect(node.arguments[0]);
            if (ts.isJsxAttribute(node) && ['label', 'confirmLabel'].includes(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer)) collect(node.initializer);
            // Preference options carry untranslated English in tuple position 2.
            if (ts.isJsxAttribute(node) && node.name.getText(source) === 'options' && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression && ts.isArrayLiteralExpression(node.initializer.expression)) {
                for (const option of node.initializer.expression.elements) if (ts.isArrayLiteralExpression(option) && option.elements[1]) collect(option.elements[1]);
            }
            ts.forEachChild(node, walk);
        }; walk(source);
    }
    Object.values(palettes).forEach(palette => keys.add(palette.name));
    Object.values(palettePairs).forEach(pair => keys.add(pair.name));
    keyboardShortcuts.forEach(shortcut => { keys.add(shortcut.label); keys.add(shortcut.when); });
    // Database details select these labels dynamically from synchronization state.
    ['No pending changes', 'Unsaved changes', 'Saving…', 'Remote save pending', 'Save failed'].forEach(key => keys.add(key));
    keys.add('Ignore password issues for this entry'); keys.add('Resume password checks for this entry');
    for (const lang of ['de-DE', 'fr-FR'] as const) {
        const missing = [...keys].filter(key => !Object.prototype.hasOwnProperty.call(uiDictionaries[lang], key));
        expect(missing, lang).toEqual([]);
    }
});
