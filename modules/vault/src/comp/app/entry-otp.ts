import { ByteUtils, ProtectedValue } from 'kdbxweb';
import type { EntryModel } from 'models/entry-model';
import { Otp } from 'util/data/otp';

export const OtpFieldNames = ['otp', 'TOTP Seed', 'TOTP Settings'] as const;
export interface OtpDraft { action: 'keep' | 'set' | 'remove'; value: string; }
const invalid = () => new Error('Enter a valid Base32 secret or supported otpauth URL.');
const text = (value: unknown): string => value instanceof ProtectedValue ? value.getText() : String(value ?? '');

/** Read raw stored fields, never initOtpGenerator (which synthesizes a legacy field cache). */
export function otpSnapshot(entry: EntryModel | null): string {
    return JSON.stringify(OtpFieldNames.map((name) => {
        const value = entry?.entry.fields.get(name);
        return [name, value === undefined ? null : text(value), value instanceof ProtectedValue];
    }));
}
export function readEntryOtp(entry: EntryModel | null): { value: string; present: boolean; legacy: boolean } {
    const fields = entry?.entry.fields;
    const canonical = text(fields?.get('otp'));
    const seed = text(fields?.get('TOTP Seed'));
    const present = OtpFieldNames.some((name) => fields?.has(name));
    if (canonical) {
        if (/^otpauth:/i.test(canonical.trim()) || !canonical.startsWith('key=')) {
            return { value: canonical, present, legacy: !/^otpauth:/i.test(canonical.trim()) };
        }
        // KeeOTP's legacy key=...&step=...&size=... format. No mutation on read.
        try {
            const pairs = canonical.split('&').map((part) => part.split(/=(.*)/s, 2));
            if (pairs.some(([name, value]) => !['key', 'step', 'size'].includes(name) || value === undefined) ||
                new Set(pairs.map(([name]) => name)).size !== pairs.length) throw invalid();
            const args = Object.fromEntries(pairs.map(([name, value]) => [name, decodeURIComponent(value)]));
            return { value: legacyUrl(args.key ?? '', args.step, args.size), present, legacy: true };
        } catch { return { value: '', present, legacy: true }; }
    }
    const settings = text(fields?.get('TOTP Settings')).split(';');
    return { value: seed && settings.length <= 2 ? legacyUrl(seed, settings[0], settings[1]) : '', present, legacy: present };
}
function legacyUrl(seed: string, period?: string, digits?: string): string {
    return 'otpauth://totp/default?secret=' + encodeURIComponent(seed) +
        (period ? '&period=' + encodeURIComponent(period) : '') + (digits ? '&digits=' + encodeURIComponent(digits) : '');
}
function base32(input: string): string {
    const secret = input.replace(/\s/g, '').toUpperCase();
    const match = /^([A-Z2-7]+)(=*)$/.exec(secret);
    if (!match) throw invalid();
    const body = match[1], padding = match[2].length, rem = body.length % 8;
    if (![0, 2, 4, 5, 7].includes(rem) || (padding && (secret.length % 8 !== 0 || padding !== 8 - rem))) throw invalid();
    const decoded = Otp.fromBase32(body);
    if (!decoded?.byteLength) throw invalid();
    try {
        const unused = body.length * 5 % 8;
        if (unused && ('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(body[body.length - 1]) & ((1 << unused) - 1))) throw invalid();
        return body;
    } finally { ByteUtils.zeroBuffer(decoded); }
}

/** Strict syntax before shared parsing; never propagate parser errors containing secret input. */
export function normalizeOtpInput(input: string): string {
    try {
        if (typeof input !== 'string' || input.length > 8192) throw invalid();
        let value = input.trim();
        if (!/^otpauth:/i.test(value)) value = Otp.makeUrl(base32(value));
        const match = /^otpauth:\/\/(totp|hotp)\/(.*?)\?([^#\r\n]*)$/i.exec(value);
        if (!match || /[\x00-\x20\x7f]/.test(value)) throw invalid();
        const type = match[1].toLowerCase(), label = decodeURIComponent(match[2]);
        if (!label || /[\x00-\x1f\x7f]/.test(label)) throw invalid();
        const params = new Map<string, string>();
        for (const part of match[3].split('&')) {
            const separator = part.indexOf('=');
            if (separator <= 0) throw invalid();
            const name = part.slice(0, separator).toLowerCase();
            const v = decodeURIComponent(part.slice(separator + 1));
            if (!['secret', 'algorithm', 'digits', 'period', 'counter', 'issuer'].includes(name) || params.has(name) || !v) throw invalid();
            if (/[\x00-\x1f\x7f]/.test(v)) throw invalid();
            params.set(name, v);
        }
        params.set('secret', base32(params.get('secret') ?? ''));
        if (params.has('algorithm')) params.set('algorithm', params.get('algorithm')!.toUpperCase());
        for (const name of ['period', 'counter']) if (params.has(name)) {
            const v = params.get(name)!;
            if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw invalid();
            if (name === 'period' && (type !== 'totp' || Number(v) < 1 || Number(v) > Number.MAX_SAFE_INTEGER / 1000)) throw invalid();
            // Shared generator currently encodes the counter as uint32. Reject truncation.
            if (name === 'counter' && (type !== 'hotp' || Number(v) > 0xffffffff)) throw invalid();
        }
        const url = `otpauth://${type}/${encodeURIComponent(label)}?` + [...params]
            .map(([name, v]) => `${name}=${encodeURIComponent(v)}`).join('&');
        const parsed = Otp.parseUrl(url);
        ByteUtils.zeroBuffer(parsed.key);
        return url;
    } catch { throw invalid(); }
}

/** undefined = removal; null = keep. Validate before creating an entry or changing other fields. */
export function prepareOtpDraft(draft?: OtpDraft): string | undefined | null {
    if (!draft || draft.action === 'keep') return null;
    if (draft.action === 'remove') return undefined;
    if (draft.action !== 'set') throw invalid();
    return normalizeOtpInput(draft.value);
}

/** Synchronous publication only after validation and a complete raw-factor baseline check. */
export function applyEntryOtp(entry: EntryModel, draft: OtpDraft, baseline: string): void {
    const url = prepareOtpDraft(draft);
    if (otpSnapshot(entry) !== baseline) throw new Error('The OTP configuration changed. Cancel and reopen the editor.');
    if (url !== null) entry.setOtpUrl(url);
}
