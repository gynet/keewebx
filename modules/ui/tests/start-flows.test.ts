import { expect, test } from 'bun:test';
import { classifyStartFiles } from '../src/start-files';
import { keyboardShortcutHelp, shortcutKeys } from '../src/keyboard-shortcuts';
const settings = { canOpen: true, canImportCsv: true, canImportXml: true };
const file = (name: string) => new File(['test'], name);
test('drop classification is order-independent and rejects ambiguous or policy-denied sources', () => {
    const db = file('vault.KDBX'), key = file('vault.keyx');
    expect(classifyStartFiles([key, db], settings)).toEqual({ kind: 'database', file: db, key });
    expect(() => classifyStartFiles([db, file('second.kdbx')], settings)).toThrow('exactly one');
    expect(() => classifyStartFiles([db, key, file('extra')], settings)).toThrow('one database');
    expect(() => classifyStartFiles([db], { ...settings, canOpen: false })).toThrow('disabled');
    expect(() => classifyStartFiles([file('data.CSV')], { ...settings, canImportCsv: false })).toThrow('disabled');
    expect(classifyStartFiles([file('data.xml')], settings).kind).toBe('import');
});
test('help descriptors use the actual command keys and platform modifier names', () => {
    const mac = keyboardShortcutHelp('MacIntel'), linux = keyboardShortcutHelp('Linux x86_64');
    expect(mac.find(item => item.id === 'open')?.shortcut).toBe(`Command + ${shortcutKeys.open.toUpperCase()}`);
    expect(linux.find(item => item.id === 'save')?.shortcut).toBe('Ctrl + S');
    expect(mac.find(item => item.id === 'create')?.shortcut).toBe('Option + N');
    expect(new Set(mac.map(item => item.id)).size).toBe(mac.length);
    expect(mac.every(item => item.when.length > 0)).toBe(true);
});

const { validateStartupConfig } = await import('../../vault/src/comp/app/startup-config');
test('configuration is validated completely before it can change settings or the file list', () => {
    expect(() => validateStartupConfig({ settings: { canOpen: 'false' } })).toThrow('setting');
    expect(() => validateStartupConfig({ settings: { cacheConfigSettings: true }, files: {} })).toThrow('database list');
    expect(() => validateStartupConfig({ settings: {}, files: [{ name: 'Missing destination' }] })).toThrow('database list');
    expect(() => validateStartupConfig({ settings: {}, advancedSearch: { protect: 'false' } })).toThrow('search');
    expect(() => validateStartupConfig(JSON.parse('{"settings":{"__proto__":{}}}'))).toThrow('setting');
    expect(validateStartupConfig({ settings: { canOpen: false }, files: [{ storage: 'webdav', name: 'Preset', path: 'https://example.test/db.kdbx' }] }).settings?.canOpen).toBe(false);
});
