import * as kdbxweb from 'kdbxweb';
import { View } from 'framework/views/view';
import { Scrollable } from 'framework/views/scrollable';
import template from 'templates/import-csv.hbs';
import { EntryModel } from 'models/entry-model';

interface KnownField {
    field: string;
    re: RegExp;
}

interface FieldMapping {
    type?: 'ignore' | 'builtin' | 'custom';
    mapping?: string;
    field?: string;
}

interface GroupEntry {
    id: string;
    fileId: string;
    spaces: string[];
    title: string;
}

class ImportCsvView extends View {
    parent = '.app__body';

    template = template;

    events: Record<string, string> = {
        'click .back-button': 'returnToApp',
        'click .import-csv__button-cancel': 'returnToApp',
        'click .import-csv__button-run': 'runImport',
        'change .import-csv__field-select': 'changeMapping',
        'change .import-csv__target-select': 'changeGroup'
    };

    knownFields: KnownField[] = [
        { field: 'Title', re: /title|\bname|account/i },
        { field: 'UserName', re: /user|login/i },
        { field: 'Password', re: /pass/i },
        { field: 'URL', re: /url|site/i },
        { field: 'Notes', re: /notes|comment|extra/i }
    ];

    fieldMapping: FieldMapping[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    targetGroup: any = undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appModel: any;
    fileName = '';
    groups: GroupEntry[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createScroll!: (config: any) => void;
    pageResized!: () => void;
    initScroll!: () => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scroll!: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scroller!: any;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(model: any, options: Record<string, any>) {
        super(model, options);
        this.appModel = options.appModel;
        this.fileName = options.fileName as string;
        this.guessFieldMapping();
        this.fillGroups();
        this.initScroll();
    }

    render(): this | undefined {
        super.render({
            headers: this.model.headers,
            rows: this.model.rows,
            fieldMapping: this.fieldMapping,
            groups: this.groups
        });
        this.createScroll({
            root: this.$el.find('.import-csv__body')[0],
            scroller: this.$el.find('.import-csv__body > .scroller')[0],
            bar: this.$el.find(
                '.import-csv__body > .scroller__bar-wrapper > .scroller__bar'
            )[0]
        });
        this.pageResized();
        if (!this.scroll._update) {
            this.scroll._update = this.scroll.update;
            this.scroll.update = this.scrollUpdate.bind(this);
        }
        return this;
    }

    scrollUpdate(): void {
        this.scroller.css({ width: 'auto', minWidth: 'auto', maxWidth: 'auto' });
        this.scroll._update();
    }

    returnToApp(): void {
        this.emit('cancel');
    }

    changeMapping(e: Event): void {
        const target = e.target as HTMLSelectElement;
        const col = +(target.dataset.col ?? '0');
        const field = target.value;

        const isBuiltIn = this.knownFields.some((f) => f.field === field);
        const mapping = field ? (isBuiltIn ? 'builtin' : 'custom') : 'ignore';

        this.fieldMapping[col] = {
            mapping,
            field
        };

        if (field) {
            let ix = 0;
            for (const m of this.fieldMapping) {
                if (m.field === field && col !== ix) {
                    m.type = 'ignore';
                    m.field = '';
                    const select = this.el.querySelector(
                        `.import-csv__field-select[data-col="${ix}"]`
                    ) as HTMLSelectElement | null;
                    if (select) {
                        select.value = '';
                    }
                }
                ix++;
            }
        }
    }

    guessFieldMapping(): void {
        const usedFields: Record<string, boolean> = {};

        for (const fieldName of this.model.headers.map((f: string) => f.trim())) {
            if (!fieldName || /^(group|grouping)$/i.test(fieldName)) {
                this.fieldMapping.push({ type: 'ignore' });
                continue;
            }

            let found = false;
            for (const { field, re } of this.knownFields) {
                if (!usedFields[field] && re.test(fieldName)) {
                    this.fieldMapping.push({ type: 'builtin', field });
                    usedFields[field] = true;
                    found = true;
                    break;
                }
            }

            if (!found) {
                this.fieldMapping.push({ type: 'custom', field: fieldName });
            }
        }
    }

    fillGroups(): void {
        this.groups = [];
        for (const file of this.appModel.files) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            file.forEachGroup((group: any) => {
                const title = group.title;
                const spaces: string[] = [];
                for (let parent = group; parent.parentGroup; parent = parent.parentGroup) {
                    spaces.push(' ', ' ');
                }
                this.groups.push({ id: group.id, fileId: file.id, spaces, title });
            });
        }
    }

    changeGroup(e: Event): void {
        const target = e.target as HTMLSelectElement;
        const groupId = target.value;
        if (!groupId) {
            this.targetGroup = undefined;
            return;
        }
        const option = target.querySelector(
            `option[value="${groupId}"]`
        ) as HTMLOptionElement | null;
        const fileId = option?.dataset.file;
        const file = this.appModel.files.get(fileId);
        this.targetGroup = file.getGroup(groupId);
    }

    runImport(): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let group: any = this.targetGroup;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let filePromise: Promise<any>;
        if (group) {
            filePromise = Promise.resolve(group.file);
        } else {
            const fileName = this.fileName.replace(/\.csv$/i, '');
            filePromise = new Promise((resolve) =>
                this.appModel.createNewFile(fileName, resolve)
            );
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filePromise.then((file: any) => {
            if (!group) {
                group = file.groups[0];
            }

            for (const row of this.model.rows as string[][]) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const newEntry = (EntryModel as any).newEntry(group, file);
                for (let ix = 0; ix < row.length; ix++) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    let value: any = row[ix];
                    if (!value) {
                        continue;
                    }
                    const mapping = this.fieldMapping[ix];
                    if (mapping.type === 'ignore' || !mapping.field) {
                        continue;
                    }
                    if (mapping.field === 'Password') {
                        value = kdbxweb.ProtectedValue.fromString(value);
                    }
                    newEntry.setField(mapping.field, value);
                }
            }

            file.reload();
            this.emit('done');
        });
    }
}

Object.assign(ImportCsvView.prototype, Scrollable);

export { ImportCsvView };
