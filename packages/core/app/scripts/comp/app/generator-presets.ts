import { AppSettingsModel } from 'models/app-settings-model';
import { Locale } from 'util/locale';

interface GeneratorPreset {
    name: string;
    title?: string;
    length: number;
    upper?: boolean;
    lower?: boolean;
    digits?: boolean;
    special?: boolean;
    brackets?: boolean;
    ambiguous?: boolean;
    include?: string;
    pattern?: string;
    builtIn?: boolean;
    disabled?: boolean;
    default?: boolean;
}

interface GeneratorPresetsSetting {
    user: GeneratorPreset[];
    disabled?: Record<string, boolean>;
    default?: string;
}

const GeneratorPresets = {
    get defaultPreset(): GeneratorPreset {
        return {
            name: 'Default',
            title: Locale.genPresetDefault,
            length: 16,
            upper: true,
            lower: true,
            digits: true
        };
    },

    get browserExtensionPreset(): GeneratorPreset {
        return {
            name: 'BrowserExtension',
            length: 20,
            upper: true,
            lower: true,
            special: true,
            brackets: true,
            ambiguous: true
        };
    },

    get builtIn(): GeneratorPreset[] {
        return [
            this.defaultPreset,
            {
                name: 'Pronounceable',
                title: Locale.genPresetPronounceable,
                length: 10,
                lower: true,
                upper: true
            },
            {
                name: 'Med',
                title: Locale.genPresetMed,
                length: 16,
                upper: true,
                lower: true,
                digits: true,
                special: true,
                brackets: true,
                ambiguous: true
            },
            {
                name: 'Long',
                title: Locale.genPresetLong,
                length: 32,
                upper: true,
                lower: true,
                digits: true
            },
            { name: 'Pin4', title: Locale.genPresetPin4, length: 4, digits: true },
            {
                name: 'Mac',
                title: Locale.genPresetMac,
                length: 17,
                include: '0123456789ABCDEF',
                pattern: 'XX-'
            },
            {
                name: 'Hash128',
                title: Locale.genPresetHash128,
                length: 32,
                include: '0123456789abcdef'
            },
            {
                name: 'Hash256',
                title: Locale.genPresetHash256,
                length: 64,
                include: '0123456789abcdef'
            }
        ];
    },

    get all(): GeneratorPreset[] {
        const presets: GeneratorPreset[] = this.builtIn;
        presets.forEach((preset) => {
            preset.builtIn = true;
        });
        const setting = AppSettingsModel.generatorPresets as GeneratorPresetsSetting | null;
        if (setting) {
            if (setting.user) {
                const userPresets = setting.user.map((item) => ({ ...item }));
                presets.push(...userPresets);
            }
            let hasDefault = false;
            presets.forEach((preset) => {
                if (setting.disabled && setting.disabled[preset.name]) {
                    preset.disabled = true;
                }
                if (setting.default === preset.name) {
                    hasDefault = true;
                    preset.default = true;
                }
            });
            if (!hasDefault) {
                presets[0].default = true;
            }
        }
        return presets;
    },

    get enabled(): GeneratorPreset[] {
        const allPresets = this.all.filter((preset) => !preset.disabled);
        if (!allPresets.length) {
            allPresets.push(this.defaultPreset);
        }
        return allPresets;
    },

    getOrCreateSetting(): GeneratorPresetsSetting {
        let setting = AppSettingsModel.generatorPresets as GeneratorPresetsSetting | null;
        if (!setting) {
            setting = { user: [] };
        }
        return setting;
    },

    add(preset: GeneratorPreset): void {
        const setting = this.getOrCreateSetting();
        if (preset.name && !setting.user.filter((p) => p.name === preset.name).length) {
            setting.user.push(preset);
            this.save(setting);
        }
    },

    remove(name: string): void {
        const setting = this.getOrCreateSetting();
        setting.user = setting.user.filter((p) => p.name !== name);
        this.save(setting);
    },

    setPreset(name: string, props: Partial<GeneratorPreset>): void {
        const setting = this.getOrCreateSetting();
        const preset = setting.user.filter((p) => p.name === name)[0];
        if (preset) {
            Object.assign(preset, props);
            this.save(setting);
        }
    },

    setDisabled(name: string, disabled: boolean): void {
        const setting = this.getOrCreateSetting();
        if (disabled) {
            if (!setting.disabled) {
                setting.disabled = {};
            }
            setting.disabled[name] = true;
        } else {
            if (setting.disabled) {
                delete setting.disabled[name];
            }
        }
        this.save(setting);
    },

    setDefault(name: string | null): void {
        const setting = this.getOrCreateSetting();
        if (name) {
            setting.default = name;
        } else {
            delete setting.default;
        }
        this.save(setting);
    },

    save(setting: GeneratorPresetsSetting): void {
        AppSettingsModel.set({ generatorPresets: undefined }, { silent: true });
        AppSettingsModel.generatorPresets = setting;
    }
};

export { GeneratorPresets };
export type { GeneratorPreset, GeneratorPresetsSetting };
