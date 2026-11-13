import { test, expect } from 'bun:test';
import { palettes, palettePairs, paletteTokens, paletteChoice, palettePair } from '../src/palettes';
const luminance = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
test('all named palettes keep readable text, muted text, actions and error messages', () => {
    expect(Object.keys(palettes)).toHaveLength(12);
    for (const id of Object.keys(palettes) as (keyof typeof palettes)[]) {
        const c = paletteTokens(id);
        for (const background of ['bg', 'side', 'sub', 'sel']) {
            for (const foreground of ['text', 'muted', 'error']) expect(contrast(c[foreground], c[background]), `${id} ${foreground}/${background}`).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(c['acc-text'], c.acc), id).toBeGreaterThanOrEqual(4.5);
    }
});
test('pairs cover every palette and stored unknown values have a safe fallback', () => {
    expect(new Set(Object.values(palettePairs).flatMap(p => [p.dark, p.light])).size).toBe(12);
    expect(paletteChoice('__proto__')).toBe('system'); expect(palettePair('constructor')).toBe('default');
    for (const id of Object.keys(palettes)) expect(paletteChoice(id)).toBe(id as keyof typeof palettes);
});
