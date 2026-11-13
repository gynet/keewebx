import { useEffect, useRef, useState } from 'preact/hooks';
import QrCode from 'jsqrcode';
import type { AppModel } from 'models/app-model';
import { getSessionAccess } from 'comp/app/session-access';
import { normalizeOtpInput } from 'comp/app/entry-otp';
import { t } from './i18n';

/** Decode locally; publishing the staged secret requires the same live session. */
export function OtpQrInput({ model, revision, onRead }: { model: AppModel; revision: string; onRead(secret: string): void }) {
    const input = useRef<HTMLInputElement>(null);
    const active = useRef(true), generation = useRef(0);
    const pending = useRef<(() => void) | undefined>();
    const currentRevision = useRef(revision); currentRevision.current = revision;
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    useEffect(() => {
        active.current = true;
        const unsubscribe = getSessionAccess(model).subscribeInvalidation(() => {
            ++generation.current; pending.current?.(); pending.current = undefined; setBusy(false);
        });
        return () => { active.current = false; ++generation.current; pending.current?.(); unsubscribe(); };
    }, [model]);
    const read = async (file?: File) => {
        if (!file) return;
        pending.current?.();
        const attempt = ++generation.current;
        const access = getSessionAccess(model), epoch = access.epoch;
        const current = () => active.current && generation.current === attempt && currentRevision.current === revision &&
            access.state === 'open' && access.isCurrent(epoch);
        setBusy(true); setError('');
        try {
            access.assertOpen(epoch);
            if (!/^image\/(png|jpeg|gif|webp|bmp)$/i.test(file.type) || file.size > 10 * 1024 * 1024) {
                throw new Error('Choose a PNG, JPEG, GIF, WebP or BMP image under 10 MB.');
            }
            const image = new Image();
            const url = URL.createObjectURL(file);
            const decoded = await new Promise<string>((resolve, reject) => {
                let finished = false;
                const cleanup = () => { image.onload = null; image.onerror = null; URL.revokeObjectURL(url); };
                pending.current = () => {
                    if (finished) return;
                    finished = true; cleanup(); image.src = ''; reject(new Error('QR import canceled.'));
                };
                image.onload = () => {
                    if (finished) return;
                    finished = true;
                    try {
                        if (!current()) throw new Error('QR import canceled.');
                        if (image.naturalWidth * image.naturalHeight > 20_000_000) throw new Error('Use an image smaller than 20 megapixels.');
                        resolve(new QrCode(image).decode());
                    } catch { reject(new Error('Could not read an OTP QR code from this image.')); }
                    finally { cleanup(); }
                };
                image.onerror = () => { finished = true; cleanup(); reject(new Error('Could not read this image.')); };
                image.src = url;
            });
            if (!current()) return;
            if (!/^otpauth:\/\//i.test(decoded)) throw new Error('This QR image does not contain an otpauth URL.');
            const secret = normalizeOtpInput(decoded);
            if (!current()) return;
            onRead(secret);
        } catch (failure) {
            if (current()) setError(failure instanceof Error ? t(failure.message) : t('Could not read an OTP QR code.'));
        } finally {
            if (active.current && generation.current === attempt) { pending.current = undefined; setBusy(false); }
        }
    };
    return <div class="otp-qr-input" onPaste={event => {
        const file = [...(event.clipboardData?.files ?? [])].find(file => file.type.startsWith('image/'));
        if (file) { event.preventDefault(); void read(file); }
    }}>
        <button class="link" type="button" disabled={busy} onClick={() => input.current?.click()}>
            {t(busy ? 'Reading QR image…' : 'Scan QR image')}
        </button>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" capture="environment"
            aria-label={t('OTP QR image')} hidden onChange={event => {
                const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void read(file);
            }} />
        <p class="muted">{t('Choose a QR image, use your phone camera, or paste an image here. The image stays on this device. Save the entry to apply.')}</p>
        {error && <p role="alert" class="error">{error}</p>}
    </div>;
}
