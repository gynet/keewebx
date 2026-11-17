import { useEffect, useState } from 'preact/hooks';
import { ByteUtils } from 'kdbxweb';
import type { FileModel } from 'models/file-model';
import type { EntryModel } from 'models/entry-model';
import type { AppModel } from 'models/app-model';
import { getSessionAccess } from 'comp/app/session-access';
import { Events } from 'framework/events';
import { passwordStrength, PasswordStrengthLevel } from 'util/data/password-strength';
import { usePreferences } from './app-preferences';
import { t } from './i18n';

export function PasswordAudit({ model, entry }: { model: AppModel; entry: EntryModel }) {
    const settings = usePreferences();
    const [online, setOnline] = useState('');
    const password = entry.password;
    const strength = password?.byteLength ? passwordStrength(password) : null;
    const eligible = settings.auditPasswords && entry.canCheckPasswordIssues() && !!strength &&
        !(settings.excludePinsFromAudit && strength.onlyDigits && strength.length <= 6);
    const expiry = new Date(entry.updated);
    expiry.setFullYear(expiry.getFullYear() + settings.auditPasswordAge);
    const issue = !eligible ? '' : settings.auditPasswordEntropy && strength!.level < PasswordStrengthLevel.Good
        ? 'This password is weak.' : settings.auditPasswordAge && expiry.getTime() < Date.now()
            ? 'This password is older than your chosen limit.' : '';
    const checkOnline = eligible && !issue && settings.checkPasswordsOnHIBP;
    useEffect(() => {
        setOnline('');
        if (!checkOnline) return;
        const access = getSessionAccess(model);
        const epoch = access.epoch;
        const file = entry.file as FileModel;
        const db = file.db;
        const controller = new AbortController();
        const unsubscribe = access.subscribeInvalidation(() => { controller.abort(); setOnline(''); });
        const current = () => !controller.signal.aborted && access.state === 'open' && access.isCurrent(epoch) &&
            settings.auditPasswords && settings.checkPasswordsOnHIBP && entry.canCheckPasswordIssues() && entry.password === password && file.active && file.db === db && model.files.get(file.id) === file && file.getEntry(entry.id) === entry;
        void (async () => {
            let bytes: Uint8Array | undefined;
            try {
                if (!current()) return;
                bytes = password.getBinary();
                const digest = await crypto.subtle.digest('SHA-1', ByteUtils.arrayToBuffer(bytes));
                ByteUtils.zeroBuffer(bytes); bytes = undefined;
                if (!current()) return;
                const hash = ByteUtils.bytesToHex(digest).toUpperCase();
                setOnline('Checking for known breaches…');
                const response = await fetch(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, {
                    signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'Add-Padding': 'true' }
                });
                if (!response.ok) throw new Error('Online check failed');
                const text = await response.text();
                if (!current()) return;
                const found = text.split(/\r?\n/).some(line => {
                    const [suffix, count] = line.split(':');
                    return suffix === hash.slice(5) && Number(count) > 0;
                });
                setOnline(found ? 'This password appears in known breaches.' : 'No known breach found for this password.');
            } catch { if (current()) setOnline('Online password check unavailable.'); }
            finally { if (bytes) ByteUtils.zeroBuffer(bytes); }
        })();
        return () => { controller.abort(); unsubscribe(); };
    }, [entry, password, checkOnline, model]);
    const message = issue || (checkOnline ? online : '');
    const ignored = !entry.canCheckPasswordIssues();
    const file = entry.file as FileModel;
    const writable = file.active && !(file as FileModel & { readOnly?: boolean }).readOnly;
    const toggle = () => {
        if (getSessionAccess(model).state !== 'open' || !file.active || model.files.get(file.id) !== file ||
            file.getEntry(entry.id) !== entry || (file as FileModel & { readOnly?: boolean }).readOnly) return;
        entry.setIgnorePasswordIssues(!ignored);
        setOnline('');
        Events.emit('entry-updated', { entry });
    };
    return <>
        {message && <p class="password-audit" role="status">{t(message)}</p>}
        {settings.auditPasswords && (ignored || issue || online === 'This password appears in known breaches.') &&
            <button type="button" class="link" disabled={!writable} onClick={toggle}>
                {t(ignored ? 'Resume password checks for this entry' : 'Ignore password issues for this entry')}
            </button>}
    </>;
}
