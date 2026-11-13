import { useEffect, useRef, useState } from 'preact/hooks';
import { ByteUtils } from 'kdbxweb';
import type { AppModel } from 'models/app-model';
import { Otp } from 'util/data/otp';
import { getSessionAccess } from 'comp/app/session-access';
import { normalizeOtpInput, type OtpDraft } from 'comp/app/entry-otp';
import { t } from './i18n';
import { OtpQrInput } from './otp-qr-input';

export function EntryOtpFields({ model, value, original, onChange }: {
    model: AppModel; value: OtpDraft; original: { value: string; present: boolean; legacy: boolean };
    onChange: (value: OtpDraft) => void;
}) {
    const [reveal, setReveal] = useState(false), [preview, setPreview] = useState(''), [error, setError] = useState('');
    const mounted = useRef(true), attempt = useRef(0);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++attempt.current; }; }, []);
    const change = (draft: OtpDraft) => { ++attempt.current; setPreview(''); setError(''); onChange(draft); };
    const showCode = () => {
        const access = getSessionAccess(model), epoch = access.epoch, id = ++attempt.current;
        setPreview(''); setError('');
        let generator: Otp;
        try { access.assertOpen(epoch); generator = Otp.parseUrl(normalizeOtpInput(value.value)); }
        catch { setError(t('Enter a valid Base32 secret or supported otpauth URL.')); return; }
        generator.next((error, code) => {
            ByteUtils.zeroBuffer(generator.key);
            if (!mounted.current || attempt.current !== id || access.state !== 'open' || !access.isCurrent(epoch)) return;
            if (error || !code) setError(t('Could not generate an OTP code. Check the configuration.'));
            else setPreview(code);
        });
    };
    return <fieldset class="entry-editor__custom" aria-label={t('One-time password')}>
        <legend class="section-title">{t('One-time password')}</legend>
        <OtpQrInput model={model} revision={`${value.action}:${value.value}`} onRead={secret => change({ action: 'set', value: secret })} />
        {value.action === 'keep' ? <>
            <p>{t(original.present ? 'An OTP configuration is stored in this entry.' : 'No OTP is configured.')}</p>
            {original.legacy && <p>{t('Legacy OTP configuration. Edit and save to migrate it to a protected OTP field.')}</p>}
            <button type="button" class="link" onClick={() => change({ action: 'set', value: original.value })}>
                {t(original.present ? 'Edit OTP' : 'Set up OTP')}
            </button>
        </> : value.action === 'set' ? <>
            <label class="field-label">
                <span>{t('OTP secret or otpauth URL')}</span>
                <input class="input" type={reveal ? 'text' : 'password'} value={value.value} autoComplete="off"
                    spellcheck={false} autoCapitalize="off" onInput={(event) => change({ action: 'set', value: event.currentTarget.value })} />
            </label>
            <p>{t('Enter a Base32 secret or an otpauth URL. Save the entry to apply; Cancel keeps the existing configuration.')}</p>
            <div class="entry-editor__password-actions">
                <button type="button" class="link" onClick={() => setReveal(!reveal)}>{t(reveal ? 'Hide OTP secret' : 'Show OTP secret')}</button>
                <button type="button" class="link" onClick={showCode}>{t('Preview OTP code')}</button>
            </div>
            {preview && <p role="status">{t('Preview code: {}', preview)}</p>}
        </> : <p>{t('OTP will be removed when the entry is saved.')}</p>}
        {original.present && value.action !== 'remove' && <button type="button" class="link"
            onClick={() => change({ action: 'remove', value: '' })}>{t('Remove OTP')}</button>}
        {value.action !== 'keep' && <button type="button" class="link"
            onClick={() => change({ action: 'keep', value: original.value })}>{t('Discard OTP changes')}</button>}
        {error && <p class="error" role="alert">{error}</p>}
    </fieldset>;
}
