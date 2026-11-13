import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { ByteUtils, Credentials, CryptoEngine, Int64, Kdbx, ProtectedValue, VarDictionary } from 'kdbxweb';
import { argon2d, argon2id } from 'hash-wasm';
import '../src/util/kdbxweb/protected-value-ex';
import { Otp } from '../src/util/data/otp';
import { applyEntryOtp, normalizeOtpInput, otpSnapshot, prepareOtpDraft, readEntryOtp } from '../src/comp/app/entry-otp';

// Run separately from suites that replace EntryModel with process-wide Bun mocks.
mock.module('../src/models/app-settings-model', () => ({ AppSettingsModel: {} }));
mock.module('../src/util/data/ranking', () => ({ Ranking: {} }));
const { EntryModel } = await import('../src/models/entry-model');
const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const url = `otpauth://totp/Example%3Aalice?secret=${seed}&digits=8`;
const pw = () => ProtectedValue.fromString('disposable-encrypted-otp-test');
beforeEach(() => {
    Object.defineProperty(globalThis, 'window', { value: { crypto }, configurable: true });
    CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type) =>
        ByteUtils.arrayToBuffer(await (type === CryptoEngine.Argon2TypeArgon2d ? argon2d : argon2id)({
            password: new Uint8Array(password), salt: new Uint8Array(salt), memorySize: memory,
            iterations, parallelism, hashLength: length, outputType: 'binary'
        })));
});
async function fixture(fields: Record<string, string | ProtectedValue> = {}) {
    const credentials = new Credentials(pw()); await credentials.ready;
    const db = Kdbx.create(credentials, 'OTP');
    db.header.kdfParameters!.set('M', VarDictionary.ValueType.UInt64, Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', VarDictionary.ValueType.UInt64, Int64.from(2));
    const raw = db.createEntry(db.getDefaultGroup());
    raw.fields.set('Title', 'Preserved entry'); raw.fields.set('Notes', 'Preserved notes');
    for (const [name, value] of Object.entries(fields)) raw.fields.set(name, value);
    const file = { name: 'OTP', db, historyMaxItems: 10, dirty: false, modified: false, editSeq: 0,
        subId: (id: string) => id, setModified() { this.dirty = this.modified = true; ++this.editSeq; } };
    const entry = EntryModel.fromEntry(raw, { title: 'Group' }, file);
    return { db, raw, entry, file };
}
async function roundtrip(h: Awaited<ReturnType<typeof fixture>>) {
    const bytes = await h.db.save();
    expect(new TextDecoder().decode(bytes)).not.toContain(seed);
    const db = await Kdbx.load(bytes, new Credentials(pw()));
    return db.getDefaultGroup().entries.find((entry) => entry.uuid.id === h.raw.uuid.id)!;
}
async function code(value: string, time = 59_000) {
    const otp = Otp.parseUrl(value), now = Date.now;
    Date.now = () => time;
    try { return await new Promise<string>((resolve, reject) => otp.next((error, pass) => error ? reject(error) : resolve(pass!))); }
    finally { Date.now = now; ByteUtils.zeroBuffer(otp.key); }
}
function base32(text: string): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bits = [...new TextEncoder().encode(text)].map((byte) => byte.toString(2).padStart(8, '0')).join('');
    return Array.from({ length: Math.ceil(bits.length / 5) }, (_, i) => alphabet[parseInt(bits.slice(i * 5, i * 5 + 5).padEnd(5, '0'), 2)]).join('');
}

describe('manual OTP lifecycle using real EntryModel and KDBX', () => {
    test('Classic setOtp retains its generator; setOtpUrl and removal retain protected storage and history', async () => {
        const h = await fixture({ 'TOTP Seed': ProtectedValue.fromString(seed), 'TOTP Settings': '30;8' });
        const generator = Otp.parseUrl(url);
        h.entry.setOtp(generator);
        expect(h.entry.otpGenerator).toBe(generator);
        expect(h.raw.fields.get('otp')).toBeInstanceOf(ProtectedValue);
        expect(h.raw.fields.has('TOTP Seed')).toBe(false);
        expect(h.raw.history).toHaveLength(1);
        expect(await code(((await roundtrip(h)).fields.get('otp') as ProtectedValue).getText())).toBe('94287082');
        h.entry.setOtpUrl(Otp.makeUrl(seed));
        h.entry.initOtpGenerator();
        expect(h.entry.otpGenerator!.url).toBe(Otp.makeUrl(seed));
        expect(await code((h.raw.fields.get('otp') as ProtectedValue).getText())).toBe('287082');
        h.entry.setOtpUrl(undefined);
        h.entry.initOtpGenerator();
        expect(h.entry.otpGenerator).toBeNull();
        expect((await roundtrip(h)).fields.has('otp')).toBe(false);
    });
    test('manual secret normalization protects current storage; encrypted reopen retains the actual generated code', async () => {
        const h = await fixture();
        applyEntryOtp(h.entry, { action: 'set', value: seed.toLowerCase().match(/.{1,4}/g)!.join(' ') }, otpSnapshot(h.entry));
        expect(h.raw.fields.get('otp')).toBeInstanceOf(ProtectedValue);
        const reopened = await roundtrip(h);
        const stored = reopened.fields.get('otp') as ProtectedValue;
        expect(stored).toBeInstanceOf(ProtectedValue);
        expect(await code(stored.getText())).toBe('287082');
        expect(reopened.fields.get('Title')).toBe('Preserved entry');
        expect(reopened.fields.get('Notes')).toBe('Preserved notes');
    });
    for (const [algorithm, secret, expected] of [
        ['SHA1', '12345678901234567890', '94287082'],
        ['SHA256', '12345678901234567890123456789012', '46119246'],
        ['SHA512', '1234567890'.repeat(6) + '1234', '90693936']
    ]) test(`RFC6238 ${algorithm} vector after encrypted reopen`, async () => {
        const h = await fixture();
        applyEntryOtp(h.entry, { action: 'set', value: `otpauth://totp/Test?secret=${base32(secret)}&algorithm=${algorithm}&digits=8&period=30` }, otpSnapshot(h.entry));
        const raw = await roundtrip(h);
        expect(await code((raw.fields.get('otp') as ProtectedValue).getText())).toBe(expected);
    });
    test('HOTP RFC4226 counter zero remains compatible with the shared display generator', async () => {
        const h = await fixture();
        applyEntryOtp(h.entry, { action: 'set', value: `otpauth://hotp/Test?secret=${seed}&counter=0` }, otpSnapshot(h.entry));
        const raw = await roundtrip(h);
        expect(await code((raw.fields.get('otp') as ProtectedValue).getText())).toBe('755224');
    });
    test.each(['raw', 'KeeOTP', 'TrayTOTP'])('%s legacy read/cancel never mutates; explicit migration clears both raw and cached legacy fields', async (kind) => {
        const fields = kind === 'raw' ? { otp: ProtectedValue.fromString(seed) } : kind === 'KeeOTP'
            ? { otp: ProtectedValue.fromString(`key=${seed}&step=30&size=8`) }
            : { 'TOTP Seed': ProtectedValue.fromString(seed), 'TOTP Settings': ProtectedValue.fromString('30;8') };
        const h = await fixture(fields);
        h.entry.initOtpGenerator(); // Legacy display can synthesize the cached otp field.
        const before = otpSnapshot(h.entry), state = h.raw.times.lastModTime;
        const draft = readEntryOtp(h.entry);
        expect(draft.legacy).toBe(true);
        expect(otpSnapshot(h.entry)).toBe(before);
        expect(h.file.dirty).toBe(false); expect(h.raw.history).toHaveLength(0);
        applyEntryOtp(h.entry, { action: 'keep', value: draft.value }, before);
        expect(otpSnapshot(h.entry)).toBe(before); expect(h.raw.times.lastModTime).toBe(state);
        applyEntryOtp(h.entry, { action: 'set', value: draft.value }, before);
        expect(h.raw.fields.get('otp')).toBeInstanceOf(ProtectedValue);
        for (const name of ['TOTP Seed', 'TOTP Settings']) {
            expect(h.raw.fields.has(name)).toBe(false); expect(h.entry.getAllFields()[name]).toBeUndefined();
        }
        expect(h.raw.history).toHaveLength(1);
        const raw = await roundtrip(h);
        expect(await code((raw.fields.get('otp') as ProtectedValue).getText())).toBe(kind === 'raw' ? '287082' : '94287082');
    });
    test.each([false, true])('removal records history and survives reopen, canonical present=%s', async (canonical) => {
        const h = await fixture({ ...(canonical ? { otp: ProtectedValue.fromString(url) } : {}),
            'TOTP Seed': ProtectedValue.fromString(seed), 'TOTP Settings': '30;8' });
        h.entry.initOtpGenerator();
        applyEntryOtp(h.entry, { action: 'remove', value: '' }, otpSnapshot(h.entry));
        expect(h.file.dirty).toBe(true); expect(h.raw.history).toHaveLength(1);
        // Canonical and legacy removals may each advance the mutation version.
        expect(h.file.editSeq).toBeGreaterThan(0);
        h.entry.initOtpGenerator(); expect(h.entry.otpGenerator).toBeNull();
        const raw = await roundtrip(h);
        for (const name of ['otp', 'TOTP Seed', 'TOTP Settings']) {
            expect(raw.fields.has(name)).toBe(false); expect(h.entry.getAllFields()[name]).toBeUndefined();
        }
    });
    test('changed baseline rejects a stale replacement without modifying current OTP or history', async () => {
        const h = await fixture({ otp: ProtectedValue.fromString(url) }), baseline = otpSnapshot(h.entry);
        h.raw.fields.set('TOTP Seed', ProtectedValue.fromString(seed));
        const current = otpSnapshot(h.entry);
        expect(() => applyEntryOtp(h.entry, { action: 'remove', value: '' }, baseline)).toThrow('changed');
        expect(otpSnapshot(h.entry)).toBe(current); expect(h.file.dirty).toBe(false); expect(h.raw.history).toHaveLength(0);
    });
    test('replacement preserves only the intended current configuration', async () => {
        const h = await fixture({ otp: ProtectedValue.fromString(url) });
        applyEntryOtp(h.entry, { action: 'set', value: `otpauth://hotp/Test?secret=${seed}&counter=1` }, otpSnapshot(h.entry));
        const raw = await roundtrip(h);
        expect(await code((raw.fields.get('otp') as ProtectedValue).getText())).toBe('287082');
        expect(raw.history).toHaveLength(1); // Historical recovery data is deliberately retained.
    });
    for (const [index, invalid] of ['', 'A', 'ABC', 'MZ', 'MZXW6===junk', 'secret!',
        `https://example.test/?secret=${seed}`, `otpauth://totp/Test?secret=${seed}&period=Infinity`,
        `otpauth://totp/Test?secret=${seed}&period=0`, `otpauth://totp/Test?secret=${seed}&period=1.5`,
        `otpauth://totp/Test?secret=${seed}&digits=9`, `otpauth://totp/Test?secret=${seed}&algorithm=MD5`,
        `otpauth://totp/Test?secret=${seed}&secret=${seed}`, `otpauth://totp/Test?secret=${seed}#fragment`,
        `otpauth://totp/%ZZ?secret=${seed}`, `otpauth://totp/Test?secret=${seed}&type=hotp`,
        `otpauth://hotp/Test?secret=${seed}`, `otpauth://hotp/Test?secret=${seed}&counter=4294967296`].entries()) {
        test(`invalid input case ${index + 1} rejects without mutation`, async () => {
            const h = await fixture({ otp: ProtectedValue.fromString(url) }), before = otpSnapshot(h.entry);
            expect(() => applyEntryOtp(h.entry, { action: 'set', value: invalid }, before)).toThrow('valid Base32');
            expect(otpSnapshot(h.entry)).toBe(before); expect(h.file.dirty).toBe(false); expect(h.raw.history).toHaveLength(0);
        });
    }
    test('valid RFC4648 padding is normalized; keep ignores invalid old configurations without rewriting them', () => {
        expect(normalizeOtpInput('MZXW6===')).toContain('secret=MZXW6');
        expect(prepareOtpDraft({ action: 'keep', value: 'malformed old config' })).toBeNull();
    });
});
