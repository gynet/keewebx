import { useState } from 'preact/hooks';
import { GeneratorPresets } from 'comp/app/generator-presets';
import { CharRanges, PasswordGenerator } from 'util/generators/password-generator';
import { t } from './i18n';
import './password-generator.css';

type Options = Parameters<typeof PasswordGenerator.generate>[0];

const PRESET_LABELS: Record<string, string> = {
    Default: 'Default', Pronounceable: 'Pronounceable', Med: 'All characters', Long: 'Long',
    Pin4: '4-digit PIN', Mac: 'MAC address', Hash128: '128-bit hex', Hash256: '256-bit hex'
};
const CHARACTER_SETS = [
    ['upper', 'Uppercase letters'], ['lower', 'Lowercase letters'], ['digits', 'Digits'],
    ['special', 'Symbols'], ['brackets', 'Brackets'], ['high', 'Extended characters'],
    ['ambiguous', 'Ambiguous characters']
] as const;

function generate(options: Options): { password: string; error: string } {
    if (!Number.isInteger(options.length) || options.length < 1 || options.length > 128) {
        return { password: '', error: t('Choose a length from 1 to 128.') };
    }
    if (!Object.keys(CharRanges).some((key) => options[key]) && !options.include) {
        return { password: '', error: t('Select at least one character set or add characters.') };
    }
    try {
        const password = PasswordGenerator.generate(options);
        return { password, error: password ? '' : t('Could not generate a password with these options.') };
    } catch {
        return { password: '', error: t('Could not generate a password. Try again.') };
    }
}

export function PasswordGeneratorPanel({ onUse, onClose }: {
    onUse: (password: string) => void;
    onClose: () => void;
}) {
    const [presets] = useState(() => GeneratorPresets.enabled);
    const [options, setOptions] = useState<Options>(() => ({
        ...(presets.find((preset) => preset.default) ?? presets[0])
    }));
    const [result, setResult] = useState(() => generate(options));
    const [reveal, setReveal] = useState(false);
    const change = (changes: Partial<Options>) => {
        const next = { ...options, ...changes, name: 'Custom' };
        setOptions(next);
        setResult(generate(next));
    };

    return (
        <section class="password-generator" aria-label={t('Password generator')}>
            <div class="password-generator__head">
                <h2 class="section-title">{t('Password generator')}</h2>
                <button class="link" type="button" onClick={onClose}>{t('Close generator')}</button>
            </div>
            <div class="password-generator__options">
                <label class="field-label">
                    <span>{t('Preset')}</span>
                    <select class="input" aria-label={t('Preset')} value={options.name} onChange={(event) => {
                        const preset = presets.find((item) => item.name === event.currentTarget.value);
                        if (preset) {
                            const next = { ...preset };
                            setOptions(next);
                            setResult(generate(next));
                        }
                    }}>
                        {presets.map((preset) => (
                            <option key={preset.name} value={preset.name}>{t(PRESET_LABELS[preset.name] ?? preset.name)}</option>
                        ))}
                        <option value="Custom" disabled>{t('Custom')}</option>
                    </select>
                </label>
                <label class="field-label">
                    <span>{t('Length')}</span>
                    <input class="input" type="number" min="1" max="128" step="1" value={options.length}
                        onInput={(event) => change({ length: Number(event.currentTarget.value) })} />
                </label>
            </div>
            <fieldset class="password-generator__sets">
                <legend>{t('Character sets')}</legend>
                {CHARACTER_SETS.map(([key, label]) => (
                    <label key={key}>
                        <input type="checkbox" checked={!!options[key]}
                            onChange={(event) => change({ [key]: event.currentTarget.checked })} />
                        {t(label)}
                    </label>
                ))}
            </fieldset>
            <label class="field-label">
                <span>{t('Additional characters')}</span>
                <input class="input" value={options.include ?? ''} autoComplete="off" spellcheck={false}
                    onInput={(event) => change({ include: event.currentTarget.value })} />
            </label>
            {options.pattern && <p class="muted">{t('Pattern: {}', options.pattern)}</p>}
            <label class="field-label">
                <span>{t('Generated password')}</span>
                <input class="input password-generator__result" type={reveal ? 'text' : 'password'}
                    value={result.password} readOnly autoComplete="off" spellcheck={false} />
            </label>
            <button class="link password-generator__reveal" type="button" onClick={() => setReveal(!reveal)}>
                {reveal ? t('Hide generated password') : t('Show generated password')}
            </button>
            {result.error && <p class="error" role="alert">{result.error}</p>}
            <div class="password-generator__actions">
                <button class="pill" type="button" onClick={() => setResult(generate(options))}>{t('Generate again')}</button>
                <button class="pill pill--primary" type="button" disabled={!result.password || !!result.error}
                    onClick={() => onUse(result.password)}>{t('Use this password')}</button>
            </div>
        </section>
    );
}
