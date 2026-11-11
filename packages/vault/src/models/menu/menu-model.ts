import { Model } from 'framework/model';
import { Events } from 'framework/events';
import { MenuSectionCollection } from 'collections/menu/menu-section-collection';
import { Colors } from 'const/colors';
import { Keys } from 'const/keys';
import { GroupsMenuModel } from 'models/menu/groups-menu-model';
import { MenuSectionModel } from 'models/menu/menu-section-model';
import { MenuItemModel } from 'models/menu/menu-item-model';
import { StringFormat } from 'util/formatting/string-format';
import { Locale } from 'util/locale';
import { Features } from 'util/features';

// DefaultTagItem extends Record<string, unknown> so it can flow into
// MenuSectionModel's constructor (which accepts an array of
// MenuItemModel | Record<string, unknown>) and into the section's
// `defaultItems: Record<string, unknown>[]` slot without a cast.
interface DefaultTagItem extends Record<string, unknown> {
    title: string;
    icon: string;
    defaultItem: boolean;
    disabled: {
        header: string;
        body: string;
        icon: string;
    };
}

class MenuModel extends Model {
    declare sections: MenuSectionCollection | null;
    declare menu: unknown | null;

    menus!: Record<string, MenuSectionCollection>;
    allItemsSection!: MenuSectionModel;
    allItemsItem!: MenuItemModel;
    groupsSection!: GroupsMenuModel;
    colorsSection!: MenuSectionModel;
    colorsItem!: MenuItemModel;
    tagsSection!: MenuSectionModel & { defaultItems: Record<string, unknown>[] | null };
    trashSection!: MenuSectionModel;
    generalSection!: MenuSectionModel;
    shortcutsSection!: MenuSectionModel;
    browserSection!: MenuSectionModel | undefined;
    aboutSection!: MenuSectionModel;
    helpSection!: MenuSectionModel;
    fileSettingsSection!: MenuSectionModel;
    filesSection!: MenuSectionModel;

    constructor() {
        super();
        this.menus = {};
        this.allItemsSection = new MenuSectionModel([
            {
                locTitle: 'menuAllItems',
                icon: 'th-large',
                active: true,
                shortcut: Keys.DOM_VK_A,
                filterKey: '*'
            }
        ]);
        this.allItemsItem = this.allItemsSection.items[0] as MenuItemModel;
        this.groupsSection = new GroupsMenuModel();
        this.colorsSection = new MenuSectionModel([
            {
                locTitle: 'menuColors',
                icon: 'bookmark',
                shortcut: Keys.DOM_VK_C,
                cls: 'menu__item-colors',
                filterKey: 'color',
                filterValue: true
            }
        ]);
        this.colorsItem = this.colorsSection.items[0] as MenuItemModel;
        const defTags = [this._getDefaultTagItem()];
        this.tagsSection = new MenuSectionModel(defTags) as MenuSectionModel & {
            defaultItems: Record<string, unknown>[] | null;
        };
        this.tagsSection.set({ scrollable: true, drag: true });
        this.tagsSection.defaultItems = defTags;
        this.trashSection = new MenuSectionModel([
            {
                locTitle: 'menuTrash',
                icon: 'trash-alt',
                shortcut: Keys.DOM_VK_D,
                filterKey: 'trash',
                filterValue: true,
                drop: true
            }
        ]);
        Colors.AllColors.forEach((color: string) => {
            const option = {
                cls: `fa ${color}-color`,
                value: color,
                filterValue: color
            };
            (this.colorsSection.items[0] as MenuItemModel).addOption(option);
        });
        this.menus.app = new MenuSectionCollection([
            this.allItemsSection,
            this.colorsSection,
            this.tagsSection,
            this.groupsSection,
            this.trashSection
        ]);

        this.generalSection = new MenuSectionModel([
            {
                locTitle: 'menuSetGeneral',
                icon: 'cog',
                page: 'general',
                section: 'top',
                active: true
            },
            {
                locTitle: 'setGenAppearance',
                icon: '0',
                page: 'general',
                section: 'appearance'
            },
            {
                locTitle: 'setGenFunction',
                icon: '0',
                page: 'general',
                section: 'function'
            },
            {
                locTitle: 'setGenAudit',
                icon: '0',
                page: 'general',
                section: 'audit'
            },
            {
                locTitle: 'setGenLock',
                icon: '0',
                page: 'general',
                section: 'lock'
            },
            {
                locTitle: 'setGenStorage',
                icon: '0',
                page: 'general',
                section: 'storage'
            },
            {
                locTitle: 'advanced',
                icon: '0',
                page: 'general',
                section: 'advanced'
            }
        ]);
        this.shortcutsSection = new MenuSectionModel([
            { locTitle: 'shortcuts', icon: 'keyboard', page: 'shortcuts' }
        ]);
        if ((Features as { supportsBrowserExtensions: boolean }).supportsBrowserExtensions) {
            this.browserSection = new MenuSectionModel([
                {
                    locTitle: 'menuSetBrowser',
                    icon: (Features as { browserIcon: string }).browserIcon,
                    page: 'browser'
                }
            ]);
        }
        this.aboutSection = new MenuSectionModel([
            { locTitle: 'menuSetAbout', icon: 'info', page: 'about' }
        ]);
        this.helpSection = new MenuSectionModel([
            { locTitle: 'help', icon: 'question', page: 'help' }
        ]);
        this.fileSettingsSection = new MenuSectionModel([
            {
                locTitle: 'menuSetFile',
                icon: 'lock',
                page: 'file'
            }
        ]);
        // Hidden until a file is open. app-model.addFile/closeFile bind
        // the actual FileModel onto the item and toggle section visibility.
        this.fileSettingsSection.set({ visible: false });
        this.filesSection = new MenuSectionModel();
        this.filesSection.set({ scrollable: true, grow: true });
        this.menus.settings = new MenuSectionCollection(
            [
                this.generalSection,
                this.shortcutsSection,
                this.browserSection,
                this.aboutSection,
                this.helpSection,
                this.fileSettingsSection,
                this.filesSection
            ].filter((s): s is MenuSectionModel => !!s)
        );
        this.sections = this.menus.app;

        Events.on('set-locale', this._setLocale.bind(this));
        Events.on('select-next-menu-item', this._selectNext.bind(this));
        Events.on('select-previous-menu-item', this._selectPrevious.bind(this));

        this._setLocale();
    }

    select(sel: { item: MenuItemModel; option?: { value: string; filterValue: string; active: boolean } }): void {
        const sections = this.sections as MenuSectionCollection;
        for (const section of sections) {
            this._select(section, sel.item);
        }
        if (sections === this.menus.app) {
            this.colorsItem.options?.forEach((opt: { active: boolean }) => {
                opt.active = opt === sel.option;
            });
            this.colorsItem.iconCls =
                sel.item === this.colorsItem && sel.option ? sel.option.value + '-color' : null;
            const filterKey = sel.item.filterKey as string;
            const filterValue = (sel.option || sel.item).filterValue;
            const filter: Record<string, unknown> = {};
            filter[filterKey] = filterValue;
            Events.emit('set-filter', filter);
        } else if (sections === this.menus.settings && sel.item.page) {
            Events.emit('set-page', {
                page: sel.item.page,
                section: sel.item.section,
                file: sel.item.file
            });
        }
    }

    _selectPrevious(): void {
        let previousItem: MenuItemModel | null = null;

        const processSection = (section: MenuSectionModel | MenuItemModel): boolean => {
            if ((section as MenuItemModel).visible === false) {
                return true;
            }
            if ((section as MenuItemModel).active) {
                previousItem = section as MenuItemModel;
            }
            const items = (section as MenuSectionModel).items;
            if (items) {
                items.forEach((it: MenuItemModel) => {
                    if (it.active && previousItem) {
                        this.select({ item: previousItem });
                        return false;
                    }
                    return processSection(it);
                });
            }
            return true;
        };

        const sections = this.sections as MenuSectionCollection;
        sections.forEach((section: MenuSectionModel) => processSection(section));
    }

    _selectNext(): void {
        let activeItem: MenuItemModel | null = null;

        const processSection = (section: MenuSectionModel | MenuItemModel): boolean => {
            if ((section as MenuItemModel).visible === false) {
                return true;
            }
            if ((section as MenuItemModel).active && activeItem && section !== activeItem) {
                this.select({ item: section as MenuItemModel });
                activeItem = null;
                return false;
            }
            const items = (section as MenuSectionModel).items;
            if (items) {
                items.forEach((it: MenuItemModel) => {
                    if (it.active) {
                        activeItem = it;
                    }
                    return processSection(it);
                });
            }
            return true;
        };

        const sections = this.sections as MenuSectionCollection;
        sections.forEach((section: MenuSectionModel) => processSection(section));
    }

    _select(item: MenuSectionModel | MenuItemModel, selectedItem: MenuItemModel): void {
        const items = (item as MenuSectionModel).items;
        if (items) {
            for (const it of items) {
                (it as MenuItemModel).active = it === selectedItem;
                this._select(it as MenuItemModel, selectedItem);
            }
        }
    }

    _setLocale(): void {
        for (const menu of [this.menus.app, this.menus.settings]) {
            for (const section of menu) {
                for (const item of (section as MenuSectionModel).items) {
                    if ((item as MenuItemModel).locTitle) {
                        (item as MenuItemModel).title = StringFormat.capFirst(
                            (Locale as Record<string, string>)[(item as MenuItemModel).locTitle]
                        );
                    }
                }
            }
        }
        this.tagsSection.defaultItems![0] = this._getDefaultTagItem();
    }

    _getDefaultTagItem(): DefaultTagItem {
        return {
            title: StringFormat.capFirst((Locale as Record<string, string>).tags),
            icon: 'hashtag',
            defaultItem: true,
            disabled: {
                header: (Locale as Record<string, string>).menuAlertNoTags,
                body: (Locale as Record<string, string>).menuAlertNoTagsBody,
                icon: 'hashtag'
            }
        };
    }

    setMenu(type: string): void {
        this.sections = this.menus[type];
    }
}

MenuModel.defineModelProperties(
    {
        sections: null,
        menu: null
    },
    { extensions: true }
);

export { MenuModel };
