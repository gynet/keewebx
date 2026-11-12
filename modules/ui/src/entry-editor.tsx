import { useRef, useState } from 'preact/hooks';
import { ProtectedValue } from 'kdbxweb';
import { BuiltInFields } from 'const/entry-fields';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import { PasswordGeneratorPanel } from './password-generator';
import { t } from './i18n';
import './entry-editor.css';
import { usePendingDraft } from './pending-drafts';
import { EntryHistory } from './entry-history';

const FIELDS = [
    { name: 'Title', label: 'Title' },
    { name: 'UserName', label: 'Username' },
    { name: 'Password', label: 'Password' },
    { name: 'URL', label: 'Website' },
    { name: 'Notes', label: 'Notes' }
] as const;
const reservedNames = new Set([...BuiltInFields, 'otp'].map((name) => name.toLowerCase()));

interface CustomField {
    id: number;
    originalName?: string;
    name: string;
    value: string;
    protected: boolean;
}

export interface EntryDraft {
    fields: Record<string, string>;
    tags: string;
    custom: CustomField[];
}

function fieldText(value: unknown): string {
    return value instanceof ProtectedValue ? value.getText() : String(value ?? '');
}

function customName(field: CustomField): string {
    return field.name === field.originalName ? field.name : field.name.trim();
}

function makeDraft(entry: EntryModel | null, tags: string[]): EntryDraft {
    const fields = entry?.getAllFields() ?? {};
    return {
        fields: Object.fromEntries(FIELDS.map(({ name }) => [name, fieldText(fields[name])])),
        tags: (entry?.tags ?? tags).join(', '),
        custom: Object.entries(fields)
            .filter(([name]) => !reservedNames.has(name.toLowerCase()))
            .map(([name, value], id) => ({
                id, originalName: name, name, value: fieldText(value), protected: value instanceof ProtectedValue
            }))
    };
}

/** Apply only changed fields, letting the model own history and file modification. */
export function applyEntryDraft(entry: EntryModel, draft: EntryDraft): void {
    const original = entry.getAllFields();
    for (const { name } of FIELDS) {
        const value = draft.fields[name];
        if (fieldText(original[name]) !== value) {
            entry.setField(name, name === 'Password' || original[name] instanceof ProtectedValue
                ? ProtectedValue.fromString(value) : value);
        }
    }

    const names = new Set(draft.custom.map(customName));
    for (const name of Object.keys(original)) {
        if (!reservedNames.has(name.toLowerCase()) && !names.has(name)) {
            entry.setField(name, undefined);
        }
    }
    for (const field of draft.custom) {
        const name = customName(field);
        const previous = original[field.originalName ?? name];
        const unchanged = field.originalName === name && fieldText(previous) === field.value
            && (previous instanceof ProtectedValue) === field.protected;
        if (!unchanged) {
            const value = field.protected ? ProtectedValue.fromString(field.value) : field.value;
            entry.setField(name, value, true);
        }
    }
    if (entry.tags.join(', ') !== draft.tags) {
        const tags = draft.tags.split(/[,;\n]/).map((tag) => tag.trim()).filter(Boolean);
        entry.setTags([...new Set(tags)]);
    }
}

export function EntryEditor({ entry, tags = [], onSave, onCancel }: {
    entry: EntryModel | null;
    tags?: string[];
    onSave: (draft: EntryDraft) => void;
    onCancel: () => void;
}) {
    const [draft, setDraft] = useState(() => makeDraft(entry, tags));
    const initialDraft = useRef(JSON.stringify(draft));
    const nextId = useRef(draft.custom.length);
    const [reveal, setReveal] = useState(false);
    const [generatorOpen, setGeneratorOpen] = useState(false);
    const [error, setError] = useState('');
    const updateCustom = (id: number, changes: Partial<CustomField>) => setDraft((current) => ({
        ...current, custom: current.custom.map((field) => field.id === id ? { ...field, ...changes } : field)
    }));
    const save = () => {
        if (entry && ((entry.file as FileModel).getEntry(entry.id) !== entry || JSON.stringify(makeDraft(entry, tags)) !== initialDraft.current)) {
            setError(t('This entry changed while you were editing. Copy your changes, then cancel and reopen the editor.'));
            return false;
        }
        const names = new Set<string>();
        for (const field of draft.custom) {
            const name = field.name.trim().toLowerCase();
            if (!name || reservedNames.has(name) || names.has(name)) {
                setError(t('Custom fields need unique names that are not built-in field names.'));
                return false;
            }
            names.add(name);
        }
        onSave(draft);
        return true;
    };
    usePendingDraft(JSON.stringify(draft) !== initialDraft.current, save, onCancel);

    return (
        <main class="detail entry-editor" aria-label={entry ? t('Edit entry') : t('New entry')}>
            <form class="entry-editor__form" onSubmit={(event) => { event.preventDefault(); save(); }}>
                <div class="entry-editor__head">
                    <h1 class="detail__title">{entry ? t('Edit entry') : t('New entry')}</h1>
                    <div class="entry-editor__actions">
                        {entry && <EntryHistory entry={entry} hasDraft={JSON.stringify(draft) !== initialDraft.current}
                            onRestore={() => {
                                const restored = makeDraft(entry, tags);
                                initialDraft.current = JSON.stringify(restored);
                                nextId.current = restored.custom.length;
                                setDraft(restored); setError('');
                            }} />}
                        <button class="pill" type="button" onClick={onCancel}>{t('Cancel')}</button>
                        <button class="pill pill--primary" type="submit">{t('Save')}</button>
                    </div>
                </div>
                {FIELDS.map(({ name, label }) => (
                    <div class="entry-editor__field" key={name}>
                        <label class="field-label">
                            <span>{t(label)}</span>
                            {name === 'Notes' ? (
                                <textarea class="input entry-editor__notes" value={draft.fields[name]}
                                    onInput={(event) => setDraft({ ...draft, fields: { ...draft.fields, [name]: event.currentTarget.value } })} />
                            ) : (
                                <input class="input" type={name === 'Password' && !reveal ? 'password' : 'text'}
                                    autoFocus={name === 'Title'} autoComplete="off" spellcheck={false}
                                    value={draft.fields[name]}
                                    onInput={(event) => setDraft({ ...draft, fields: { ...draft.fields, [name]: event.currentTarget.value } })} />
                            )}
                        </label>
                        {name === 'Password' && (
                            <>
                                <div class="entry-editor__password-actions">
                                    <button class="link" type="button" onClick={() => setReveal(!reveal)}>
                                        {reveal ? t('Hide password') : t('Show password')}
                                    </button>
                                    <button class="link" type="button" aria-expanded={generatorOpen}
                                        onClick={() => setGeneratorOpen(!generatorOpen)}>{t('Generate password')}</button>
                                </div>
                                {generatorOpen && <PasswordGeneratorPanel onClose={() => setGeneratorOpen(false)}
                                    onUse={(password) => {
                                        setDraft((current) => ({ ...current, fields: { ...current.fields, Password: password } }));
                                        setGeneratorOpen(false);
                                    }} />}
                            </>
                        )}
                    </div>
                ))}
                <label class="field-label entry-editor__field">
                    <span>{t('Tags')}</span>
                    <input class="input" value={draft.tags} placeholder={t('Separate tags with commas')}
                        onInput={(event) => setDraft({ ...draft, tags: event.currentTarget.value })} />
                </label>
                <fieldset class="entry-editor__custom">
                    <legend class="section-title">{t('Custom fields')}</legend>
                    {draft.custom.map((field) => (
                        <div class="entry-editor__custom-row" key={field.id}>
                            <label class="field-label">
                                <span>{t('Field name')}</span>
                                <input class="input" value={field.name} autoComplete="off"
                                    onInput={(event) => updateCustom(field.id, { name: event.currentTarget.value })} />
                            </label>
                            <label class="field-label">
                                <span>{t('Field value')}</span>
                                <input class="input" type={field.protected ? 'password' : 'text'}
                                    value={field.value} autoComplete="off" spellcheck={false}
                                    onInput={(event) => updateCustom(field.id, { value: event.currentTarget.value })} />
                            </label>
                            <label class="entry-editor__protect">
                                <input type="checkbox" checked={field.protected}
                                    onChange={(event) => updateCustom(field.id, { protected: event.currentTarget.checked })} />
                                {t('Protected')}
                            </label>
                            <button class="link" type="button" onClick={() => setDraft({
                                ...draft, custom: draft.custom.filter((item) => item.id !== field.id)
                            })}>{t('Remove field')}</button>
                        </div>
                    ))}
                    <button class="link" type="button" onClick={() => setDraft({
                        ...draft, custom: [...draft.custom, { id: nextId.current++, name: '', value: '', protected: false }]
                    })}>{t('Add field')}</button>
                </fieldset>
                {error && <p class="error" role="alert">{error}</p>}
            </form>
        </main>
    );
}
