import { useState } from 'preact/hooks';
import { GeneratorPresets, type GeneratorPreset } from 'comp/app/generator-presets';
import { IdGenerator } from 'util/generators/id-generator';
import { presetOptions, saveGeneratorPresets, validateGeneratorOptions, type GeneratorOptions } from './generator-preset-settings';
import { t } from './i18n';

export function GeneratorPresetEditor({ options, select, changed }: {
    options: GeneratorOptions; select: (preset: GeneratorPreset) => void; changed: () => void;
}) {
    const [selected, setSelected] = useState('Default');
    const [title, setTitle] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const all = GeneratorPresets.all;
    const preset = all.find(item => item.name === selected) ?? all[0];
    const name = () => {
        const value = title.trim();
        if (!value || value.length > 80) throw new Error('Enter a preset name from 1 to 80 characters.');
        if (all.some(item => item.name !== preset.name && [item.name, item.title].some(label => label?.toLowerCase() === value.toLowerCase()))
            || ['custom', 'derived'].includes(value.toLowerCase())) throw new Error('Choose a unique preset name.');
        return value;
    };
    const run = async (action: 'create' | 'save' | 'delete' | 'enable' | 'default') => {
        if (busy) return;
        setBusy(true); setMessage('');
        try {
            if (action === 'delete' && !window.confirm(t('Delete preset {}?', preset.title || preset.name))) return;
            let selectedName = preset.name;
            await saveGeneratorPresets(setting => {
                if (action === 'create' || action === 'save') {
                    validateGeneratorOptions(options);
                    const label = name();
                    if (action === 'create') {
                        if (all.some(item => [item.name, item.title].some(value => value?.toLowerCase() === label.toLowerCase()))) throw new Error('Choose a unique preset name.');
                        selectedName = `Custom-${IdGenerator.uuid()}`;
                        setting.user.push({ ...presetOptions(options), name: selectedName, title: label });
                    } else {
                        if (preset.builtIn) throw new Error('Save a built-in preset as a new preset first.');
                        setting.user = setting.user.map(item => item.name === preset.name ? { ...presetOptions(options), name: preset.name, title: label } : item);
                    }
                } else if (action === 'delete') {
                    if (preset.builtIn) throw new Error('Built-in presets cannot be deleted.');
                    setting.user = setting.user.filter(item => item.name !== preset.name);
                    if (setting.disabled) delete setting.disabled[preset.name];
                    if (setting.default === preset.name) delete setting.default;
                    selectedName = GeneratorPresets.builtIn.find(item => !setting.disabled?.[item.name])?.name
                        ?? setting.user.find(item => !setting.disabled?.[item.name])?.name ?? '';
                    if (!selectedName) throw new Error('Keep at least one enabled preset.');
                    if (!setting.default) setting.default = selectedName;
                } else if (action === 'enable') {
                    if (!preset.disabled && (preset.name === (GeneratorPresets.enabled.find(item => item.default) ?? GeneratorPresets.enabled[0]).name || GeneratorPresets.enabled.length === 1)) throw new Error('Choose another enabled default before disabling this preset.');
                    setting.disabled = { ...setting.disabled, [preset.name]: !preset.disabled };
                } else {
                    if (preset.disabled) throw new Error('Enable the preset before making it the default.');
                    validateGeneratorOptions({ ...preset }); setting.default = preset.name;
                }
            });
            const updated = GeneratorPresets.all.find(item => item.name === selectedName)!;
            setSelected(selectedName); setTitle(updated.title || updated.name);
            if (action !== 'enable') select(updated);
            else if (!preset.disabled && options.name === preset.name) select(GeneratorPresets.enabled.find(item => item.default) ?? GeneratorPresets.enabled[0]);
            changed(); setMessage(t('Preset settings saved.'));
        } catch (error) { setMessage(t((error as Error).message)); }
        finally { setBusy(false); }
    };
    return <details class="generator-presets">
        <summary>{t('Manage presets')}</summary>
        <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
            <label class="field-label">{t('Manage preset')}
                <select class="input" aria-label={t('Manage preset')} value={preset.name} onChange={event => {
                    const next = all.find(item => item.name === event.currentTarget.value)!;
                    setSelected(next.name); setTitle(next.title || next.name); select(next); setMessage('');
                }}>{all.map(item => <option value={item.name}>{item.title || item.name}{item.disabled ? t(' (disabled)') : ''}{item.default ? t(' (default)') : ''}</option>)}</select>
            </label>
            <label class="field-label">{t('Preset name')}<input class="input" value={title} maxLength={80} onInput={event => setTitle(event.currentTarget.value)} /></label>
            <p class="muted">{t('Set length, character sets and pattern above, then save. Built-in presets can be copied but not renamed or deleted.')}</p>
            <div class="password-generator__actions">
                <button type="button" class="pill" onClick={() => void run('create')}>{t('Save as new preset')}</button>
                {!preset.builtIn && <button type="button" class="pill" onClick={() => void run('save')}>{t('Save preset changes')}</button>}
                {!preset.builtIn && <button type="button" class="pill" onClick={() => void run('delete')}>{t('Delete preset')}</button>}
                <button type="button" class="pill" onClick={() => void run('enable')}>{t(preset.disabled ? 'Enable preset' : 'Disable preset')}</button>
                <button type="button" class="pill" disabled={preset.disabled || preset.default} onClick={() => void run('default')}>{t('Make default')}</button>
            </div>
        </fieldset>
        {message && <p role="status">{message}</p>}
    </details>;
}
