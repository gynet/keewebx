import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The popup, side panel and settings page take all text from
 * _locales/<locale>/messages.json through t('ui…'). These checks keep that
 * true, so adding a language is only a matter of adding a messages file.
 */

const root = path.resolve(__dirname, '..');
const english = JSON.parse(fs.readFileSync(path.join(root, '_locales/en_US/messages.json'), 'utf8')) as Record<
    string,
    { message: string; placeholders?: Record<string, { content: string }> }
>;

function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
        const p = path.join(dir, d.name);
        return d.isDirectory() ? sources(p) : /\.tsx?$/.test(d.name) ? [p] : [];
    });
}

const uiFiles = ['src/popup', 'src/settings', 'src/ui'].flatMap((d) => sources(path.join(root, d)));
const code = uiFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const usedKeys = new Set([...code.matchAll(/['"`](ui[A-Z]\w*)['"`]/g)].map((m) => m[1]));

describe('UI text', () => {
    test('every key the UI uses has English text', () => {
        expect(usedKeys.size).toBeGreaterThan(40);
        const missing = [...usedKeys].filter((k) => !english[k]?.message);
        expect(missing).toEqual([]);
    });

    test('every English ui key is used', () => {
        const unused = Object.keys(english).filter((k) => k.startsWith('ui') && !usedKeys.has(k));
        expect(unused).toEqual([]);
    });

    test('placeholders are declared for each $NAME$ in a message', () => {
        for (const [key, { message, placeholders }] of Object.entries(english)) {
            if (!key.startsWith('ui')) {
                continue;
            }
            for (const [, name] of message.matchAll(/\$([A-Z_]+)\$/g)) {
                expect(placeholders?.[name.toLowerCase()], `${key} ${name}`).toBeDefined();
            }
        }
    });

    test('no plain English text between JSX tags', () => {
        const offenders = uiFiles.flatMap((f) =>
            [...fs.readFileSync(f, 'utf8').matchAll(/>\s*([A-Z][a-z]+(?: [a-z]+)+)\s*</g)].map(
                (m) => `${path.relative(root, f)}: ${m[1]}`
            )
        );
        expect(offenders).toEqual([]);
    });

    test('other locales only carry keys that exist in English', () => {
        for (const locale of fs.readdirSync(path.join(root, '_locales'))) {
            const messages = JSON.parse(
                fs.readFileSync(path.join(root, '_locales', locale, 'messages.json'), 'utf8')
            ) as Record<string, unknown>;
            const extra = Object.keys(messages).filter((k) => !english[k]);
            expect(extra, locale).toEqual([]);
        }
    });
});
