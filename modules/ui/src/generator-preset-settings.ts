import { GeneratorPresets, type GeneratorPresetsSetting } from 'comp/app/generator-presets';
import { AppSettingsModel } from 'models/app-settings-model';
import { SettingsStore } from 'comp/settings/settings-store';
import { CharRanges, PasswordGenerator } from 'util/generators/password-generator';

export type GeneratorOptions = Parameters<typeof PasswordGenerator.generate>[0];
const optionKeys = ['length', ...Object.keys(CharRanges), 'include', 'pattern'] as const;
export function presetOptions(options: GeneratorOptions): GeneratorOptions {
    return Object.fromEntries(optionKeys.filter(key => options[key] !== undefined).map(key => [key, options[key]])) as GeneratorOptions;
}
export function validateGeneratorOptions(options: GeneratorOptions): void {
    if (!Number.isInteger(options.length) || options.length < 1 || options.length > 128) throw new Error('Choose a length from 1 to 128.');
    if (!Object.keys(CharRanges).some(key => options[key]) && !options.include) throw new Error('Select at least one character set or add characters.');
    if ((options.pattern?.length ?? 0) > 128 || (options.include?.length ?? 0) > 1024) throw new Error('Pattern or additional characters are too long.');
    const pattern = options.pattern || 'X';
    let random = false;
    for (let index = 0; index < options.length; index++) {
        const token = pattern[index % pattern.length];
        if (token === 'I' && !options.include) throw new Error('Pattern I requires additional characters.');
        if ('XAa1*[Ä0'.includes(token) || (token === 'I' && options.include)) random = true;
    }
    if (!random) throw new Error('The pattern must include a random character position.');
}

/** Use the shared preset writer and verify its existing settings-store write. */
export async function saveGeneratorPresets(change: (setting: GeneratorPresetsSetting) => void): Promise<void> {
    if (!AppSettingsModel.canOpenGenerator) throw new Error('Password generation is disabled.');
    const previous = AppSettingsModel.generatorPresets;
    const next = JSON.parse(JSON.stringify(GeneratorPresets.getOrCreateSetting())) as GeneratorPresetsSetting;
    change(next);
    GeneratorPresets.save(next);
    try {
        const stored = await SettingsStore.load('app-settings') as { generatorPresets?: unknown } | null;
        if (JSON.stringify(stored?.generatorPresets) !== JSON.stringify(next)) throw new Error('Preset settings could not be saved on this device.');
    } catch (error) {
        if (AppSettingsModel.generatorPresets === next) AppSettingsModel.set({ generatorPresets: previous }, { silent: true });
        throw error;
    }
}
