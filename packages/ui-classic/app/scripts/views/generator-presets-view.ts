import { Events } from 'framework/events';
import { View } from 'framework/views/view';
import { GeneratorPresets } from 'comp/app/generator-presets';
import { PasswordGenerator, CharRanges } from 'util/generators/password-generator';
import { Locale } from 'util/locale';
import { Scrollable } from 'framework/views/scrollable';
import template from 'templates/generator-presets.hbs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loc = Locale as unknown as Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const genPresets = GeneratorPresets as unknown as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const charRanges = CharRanges as unknown as Record<string, string>;

interface GeneratorPreset {
    name: string;
    title: string;
    length?: number;
    upper?: boolean;
    lower?: boolean;
    digits?: boolean;
    special?: boolean;
    brackets?: boolean;
    ambiguous?: boolean;
    high?: boolean;
    include?: string;
    pattern?: string;
    default?: boolean;
    [key: string]: unknown;
}

class GeneratorPresetsView extends View {
    parent = '.app__panel';

    template = template;

    events: Record<string, string> = {
        'click .back-button': 'returnToApp',
        'change .gen-ps__list': 'changePreset',
        'click .gen-ps__btn-create': 'createPreset',
        'click .gen-ps__btn-delete': 'deletePreset',
        'click .info-btn--pattern': 'togglePatternHelp',
        'input #gen-ps__field-title': 'changeTitle',
        'change #gen-ps__check-enabled': 'changeEnabled',
        'change #gen-ps__check-default': 'changeDefault',
        'input #gen-ps__field-length': 'changeLength',
        'change .gen-ps__check-range': 'changeRange',
        'input #gen-ps__field-include': 'changeInclude',
        'input #gen-ps__field-pattern': 'changePattern'
    };

    selected: string | null = null;

    presets: GeneratorPreset[] = [];

    reservedTitles: string[] = [loc.genPresetDerived as string];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createScroll!: (config: any) => void;
    pageResized!: () => void;

    render(): this | undefined {
        this.presets = genPresets.all as GeneratorPreset[];
        if (!this.selected || !this.presets.some((p) => p.name === this.selected)) {
            this.selected = (
                this.presets.filter((p) => p.default)[0] || this.presets[0]
            ).name;
        }
        super.render({
            presets: this.presets,
            selected: this.getPreset(this.selected),
            ranges: this.getSelectedRanges()
        });
        this.createScroll({
            root: this.$el.find('.gen-ps')[0],
            scroller: this.$el.find('.scroller')[0],
            bar: this.$el.find('.scroller__bar')[0]
        });
        this.renderExample();
        return this;
    }

    renderExample(): void {
        const selectedPreset = this.getPreset(this.selected);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const example = (PasswordGenerator as any).generate(selectedPreset);
        this.$el.find('.gen-ps__example').text(example);
        this.pageResized();
    }

    getSelectedRanges(): Array<{
        name: string;
        title: string;
        enabled: unknown;
        sample: string;
    }> {
        const sel = this.getPreset(this.selected);
        const rangeOverride: Record<string, string> = {
            high: '\u00a1\u00a2\u00a3\u00a4\u00a5\u00a6\u00a7\u00a9\u00aa\u00ab\u00ac\u00ae\u00af\u00b0\u00b1\u00b9\u00b2\u00b4\u00b5\u00b6\u00bb\u00bc\u00f7\u00bf\u00c0\u00d6\u00ee\u00fc...'
        };
        return ['Upper', 'Lower', 'Digits', 'Special', 'Brackets', 'High', 'Ambiguous'].map(
            (name) => {
                const nameLower = name.toLowerCase();
                return {
                    name: nameLower,
                    title: loc['genPs' + name] as string,
                    enabled: sel?.[nameLower],
                    sample: rangeOverride[nameLower] || charRanges[nameLower]
                };
            }
        );
    }

    getPreset(name: string | null): GeneratorPreset | undefined {
        return this.presets.filter((p) => p.name === name)[0];
    }

    returnToApp(): void {
        Events.emit('edit-generator-presets');
    }

    changePreset(e: Event): void {
        this.selected = (e.target as HTMLSelectElement).value;
        this.render();
    }

    createPreset(): void {
        let name = '';
        let title = '';
        for (let i = 1; ; i++) {
            const newName = 'Custom' + i;
            const newTitle = (loc.genPsNew as string) + ' ' + i;
            if (
                !this.presets.filter((p) => p.name === newName || p.title === newTitle).length
            ) {
                name = newName;
                title = newTitle;
                break;
            }
        }
        const selected = this.getPreset(this.selected);
        if (!selected) return;
        const preset: GeneratorPreset = {
            name,
            title,
            length: selected.length,
            upper: selected.upper,
            lower: selected.lower,
            digits: selected.digits,
            special: selected.special,
            brackets: selected.brackets,
            ambiguous: selected.ambiguous,
            include: selected.include
        };
        genPresets.add(preset);
        this.selected = name;
        this.render();
    }

    deletePreset(): void {
        genPresets.remove(this.selected);
        this.render();
    }

    togglePatternHelp(): void {
        this.$el.find('.gen-ps__pattern-help').toggleClass('hide');
    }

    changeTitle(e: Event): void {
        const target = e.target as HTMLInputElement;
        const title = $.trim(target.value);
        const currentPreset = this.getPreset(this.selected);
        if (title && currentPreset && title !== currentPreset.title) {
            let duplicate = this.presets.some(
                (p) => p.title.toLowerCase() === title.toLowerCase()
            );
            if (!duplicate) {
                duplicate = this.reservedTitles.some(
                    (p) => p.toLowerCase() === title.toLowerCase()
                );
            }
            if (duplicate) {
                $(target).addClass('input--error');
                return;
            } else {
                $(target).removeClass('input--error');
            }
            genPresets.setPreset(this.selected, { title });
            this.$el.find('.gen-ps__list option[selected]').text(title);
        }
    }

    changeEnabled(e: Event): void {
        const enabled = (e.target as HTMLInputElement).checked;
        genPresets.setDisabled(this.selected, !enabled);
    }

    changeDefault(e: Event): void {
        const isDefault = (e.target as HTMLInputElement).checked;
        genPresets.setDefault(isDefault ? this.selected : null);
    }

    changeLength(e: Event): void {
        const target = e.target as HTMLInputElement;
        const length = +target.value;
        if (length > 0) {
            genPresets.setPreset(this.selected, { length });
            $(target).removeClass('input--error');
        } else {
            $(target).addClass('input--error');
        }
        this.presets = genPresets.all as GeneratorPreset[];
        this.renderExample();
    }

    changeRange(e: Event): void {
        const target = e.target as HTMLInputElement;
        const enabled = target.checked;
        const range = target.dataset.range;
        if (range) {
            genPresets.setPreset(this.selected, { [range]: enabled });
        }
        this.presets = genPresets.all as GeneratorPreset[];
        this.renderExample();
    }

    changeInclude(e: Event): void {
        const include = (e.target as HTMLInputElement).value;
        const currentPreset = this.getPreset(this.selected);
        if (currentPreset && include !== currentPreset.include) {
            genPresets.setPreset(this.selected, { include });
        }
        this.presets = genPresets.all as GeneratorPreset[];
        this.renderExample();
    }

    changePattern(e: Event): void {
        const pattern = (e.target as HTMLInputElement).value;
        const currentPreset = this.getPreset(this.selected);
        if (currentPreset && pattern !== currentPreset.pattern) {
            genPresets.setPreset(this.selected, { pattern });
        }
        this.presets = genPresets.all as GeneratorPreset[];
        this.renderExample();
    }
}

Object.assign(GeneratorPresetsView.prototype, Scrollable);

export { GeneratorPresetsView };
