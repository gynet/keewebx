import { useEffect, useMemo, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import type { AttachmentModel } from 'models/attachment-model';
import { getSessionAccess } from 'comp/app/session-access';
import { PromptDialog } from './extension-prompts';
import { t } from './i18n';

export function attachmentBytes(attachment: AttachmentModel): Uint8Array {
    const bytes = attachment.getBinary();
    if (bytes) return bytes;
    const stored = attachment.data as { value?: unknown } | ArrayBuffer | undefined;
    const value = stored instanceof ArrayBuffer ? stored : stored?.value;
    if (value instanceof ArrayBuffer && value.byteLength === 0) return new Uint8Array(value);
    throw new Error('Missing attachment data');
}

export function AttachmentPreview({ model, entry, attachment, close, download }: {
    model: AppModel; entry: EntryModel; attachment: AttachmentModel; close(): void; download(): void;
}) {
    const file = entry.file as FileModel;
    const snapshot = useMemo(() => ({ db: file.db, raw: entry.entry, epoch: getSessionAccess(model).epoch }), []);
    const current = () => getSessionAccess(model).state === 'open' && getSessionAccess(model).isCurrent(snapshot.epoch) &&
        file.active && model.files.get(file.id) === file && file.db === snapshot.db && entry.entry === snapshot.raw &&
        file.getEntry(entry.id) === entry && entry.attachments.includes(attachment);
    const [url, setUrl] = useState(''), [error, setError] = useState('');
    const image = /^(png|jpe?g|gif|webp|bmp)$/.test(attachment.ext || '');
    const content = useMemo(() => {
        try {
            if (!current()) throw new Error('This attachment is no longer available.');
            const bytes = attachmentBytes(attachment);
            if (image) return bytes.byteLength <= 16 * 1024 * 1024 ? { bytes } : { message: 'This image is too large to preview. Download to open it.' };
            if (attachment.mimeType?.startsWith('text/') || /^(txt|md|csv|json|xml|log|html?|svg|css|js|ya?ml|ini|conf|pem)$/.test(attachment.ext || '')) {
                if (bytes.byteLength > 256 * 1024) return { message: 'This text is too large to preview. Download to read the complete file.' };
                return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
            }
            return { message: 'Preview is unavailable for this file type. Download to open it.' };
        } catch { return { message: 'Could not preview this attachment. Try downloading it.' }; }
    }, [attachment]);
    useEffect(() => getSessionAccess(model).subscribeInvalidation(close), [model]);
    useEffect(() => { if (!current()) close(); });
    useEffect(() => {
        if (!content.bytes || !current()) return;
        const next = URL.createObjectURL(new Blob([new Uint8Array(content.bytes).buffer], { type: attachment.mimeType }));
        setUrl(next);
        return () => URL.revokeObjectURL(next);
    }, [content]);
    return <PromptDialog title={t('Preview: {}', attachment.title || t('Attachment'))} icon="paperclip" cancel={close}>
        {url && !error && <img src={url} alt={attachment.title} onError={() => setError(t('Could not display this image.'))}
            style={{ maxWidth: '100%', maxHeight: '60dvh', objectFit: 'contain' }} />}
        {content.text !== undefined && <pre tabIndex={0} aria-label={t('Attachment text')}
            style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '60dvh', overflow: 'auto' }}>{content.text}</pre>}
        {(error || content.message) && <p role="status">{error || t(content.message!)}</p>}
        <button class="pill" type="button" onClick={() => { if (current()) download(); else close(); }}>{t('Download')}</button>
    </PromptDialog>;
}
