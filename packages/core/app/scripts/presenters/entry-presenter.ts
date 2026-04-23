import { DateFormat } from 'comp/i18n/date-format';
import { Locale } from 'util/locale';
import { AppSettingsModel } from 'models/app-settings-model';

const appSettings = AppSettingsModel as unknown as { showFavicons: boolean };

// Structural shapes for the only fields the presenter reads off the
// underlying models. EntryModel and GroupModel are JS models with
// dozens of fields each — we deliberately keep these slim instead of
// importing the full model types (cyclic), and the `entry`/`group`
// discriminator on the union sets which branch is active.
interface PresentedEntry {
    entry: true;
    id: string;
    icon: string;
    customIcon?: string;
    color?: string;
    title: string;
    notes?: string;
    displayUrl?: string;
    user?: string;
    created?: Date | number | null;
    updated?: Date | number | null;
    expired?: boolean;
    tags?: string[];
    groupName?: string;
    fileName?: string;
    attachments: { title: string }[];
}

interface PresentedGroup {
    group: true;
    id: string;
    icon?: string;
    title: string;
    active: boolean;
}

const localeBundle = Locale as Record<string, string | undefined>;

class EntryPresenter {
    entry: PresentedEntry | null = null;
    group: PresentedGroup | null = null;
    descField: string | null;
    noColor: string;
    activeEntryId: string | undefined;
    // Per-column visibility map mutated by list-view to filter what
    // gets rendered. Set after construction; absent => "show everything".
    columns?: Record<string, boolean>;
    // select-entry-view threads its `itemOptions` through the presenter
    // so the entry-row template can read them. Loose `unknown` here —
    // template indexing happens inside Handlebars.
    itemOptions?: unknown;

    constructor(descField: string | null, noColor?: string, activeEntryId?: string) {
        this.descField = descField;
        this.noColor = noColor || '';
        this.activeEntryId = activeEntryId;
    }

    present(item: PresentedEntry | PresentedGroup): this {
        if ('entry' in item && item.entry) {
            this.entry = item;
        } else if ('group' in item && item.group) {
            this.group = item;
        }
        return this;
    }

    reset(): void {
        this.entry = null;
        this.group = null;
    }

    get id(): string {
        return this.entry ? this.entry.id : this.group!.id;
    }

    get icon(): string {
        return this.entry ? this.entry.icon : this.group!.icon || 'folder';
    }

    get customIcon(): string | undefined {
        return this.entry ? this.entry.customIcon : undefined;
    }

    get favicon(): string | undefined {
        if (!appSettings.showFavicons || !this.entry || this.entry.customIcon) {
            return undefined;
        }
        const url = this.entry.displayUrl;
        if (!url) {
            return undefined;
        }
        try {
            const host = new URL(
                url.includes('://') ? url : 'https://' + url
            ).hostname;
            if (!host || host === 'localhost') {
                return undefined;
            }
            return `https://icons.duckduckgo.com/ip3/${host}.ico`;
        } catch {
            return undefined;
        }
    }

    get color(): string | undefined {
        return this.entry
            ? this.entry.color || (this.entry.customIcon ? this.noColor : undefined)
            : undefined;
    }

    get title(): string {
        return this.entry ? this.entry.title : this.group!.title;
    }

    get notes(): string | undefined {
        return this.entry ? this.entry.notes : undefined;
    }

    get url(): string | undefined {
        return this.entry ? this.entry.displayUrl : undefined;
    }



    get user(): string | undefined {
        return this.entry ? this.entry.user : undefined;
    }

    get active(): boolean {
        return this.entry ? this.entry.id === this.activeEntryId : this.group!.active;
    }

    get created(): string | undefined {
        return this.entry ? DateFormat.dtStr(this.entry.created) : undefined;
    }

    get updated(): string | undefined {
        return this.entry ? DateFormat.dtStr(this.entry.updated) : undefined;
    }

    get expired(): boolean {
        return this.entry ? !!this.entry.expired : false;
    }

    get tags(): string[] | undefined {
        return this.entry ? this.entry.tags : undefined;
    }

    get groupName(): string | undefined {
        return this.entry ? this.entry.groupName : undefined;
    }

    get fileName(): string | undefined {
        return this.entry ? this.entry.fileName : undefined;
    }

    get description(): string | undefined {
        if (!this.entry) {
            return '[' + localeBundle.listGroup + ']';
        }
        switch (this.descField) {
            case 'website':
                return this.url || '(' + localeBundle.listNoWebsite + ')';
            case 'user':
                return this.user || '(' + localeBundle.listNoUser + ')';
            case 'created':
                return this.created;
            case 'updated':
                return this.updated;
            case 'attachments':
                return (
                    this.entry.attachments.map((a) => a.title).join(', ') ||
                    '(' + localeBundle.listNoAttachments + ')'
                );
            default:
                return this.user || this.notes || this.url;
        }
    }
}

export { EntryPresenter };
