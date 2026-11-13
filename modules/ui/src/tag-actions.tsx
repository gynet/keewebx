import { useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import { Events } from 'framework/events';
import { LifecycleDialog } from './lifecycle-dialog';
import { allGroups, lifecycleSnapshot, writable } from './lifecycle-guard';
import { t } from './i18n';

export function TagActions({ model, tag, onChanged }: { model: AppModel; tag: string; onChanged: (tag?: string) => void }) {
    const [request, setRequest] = useState<{ remove: boolean; check: () => string; names: string[] } | null>(null);
    const [name, setName] = useState(tag);
    const files = [...model.files];
    const begin = (remove: boolean) => {
        if (request || files.some(file => writable(model, file))) return;
        setName(tag);
        setRequest({ remove, check: lifecycleSnapshot(model, files, true), names: files.map(file => file.name) });
    };
    return <div role="group" aria-label={t('Tag actions: {}', tag)} style={{ margin: '0 14px 6px', flex: '0 0 auto' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            <button type="button" class="pill pill--tinted" disabled={!!request || files.some(file => !!writable(model, file))} onClick={() => begin(false)}>{t('Rename tag')}</button>
            <button type="button" class="pill pill--danger" disabled={!!request || files.some(file => !!writable(model, file))} onClick={() => begin(true)}>{t('Remove tag')}</button>
        </div>
        {request && <LifecycleDialog title={t(request.remove ? 'Remove tag' : 'Rename tag')}
            confirm={t(request.remove ? 'Remove tag' : 'Rename tag')} onClose={() => setRequest(null)}
            check={() => {
                const reason = request.check();
                if (reason) return reason;
                const trimmed = name.trim();
                if (!request.remove && (!trimmed || name.length > 1024 || /[;,:]/.test(trimmed))) return t('Enter a tag name without commas, semicolons or colons (1–1024 characters).');
                if (!request.remove && files.some(file => allGroups(file).some(group => group.group.entries.some(entry => entry.tags.some(other => other.toLowerCase() === trimmed.toLowerCase()))))) return t('A tag with this name already exists.');
                return '';
            }} apply={() => {
                const next = request.remove ? '' : name.trim();
                model.renameTag(tag, next); Events.emit('refresh'); onChanged(next || undefined);
            }}>
            <p>{t('Change “{}” across all open databases, including excluded groups and trash. Entries will be retained.', tag)}</p>
            <ul>{request.names.map(name => <li>{name}</li>)}</ul>
            {!request.remove && <label class="vault-form__field">{t('Tag name')}
                <input class="input" value={name} maxLength={1024} onInput={event => setName(event.currentTarget.value)} />
            </label>}
        </LifecycleDialog>}
    </div>;
}
