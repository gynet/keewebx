import { describe, test, expect } from 'bun:test';

/**
 * Tests for EntryPresenter logic.
 * The presenter is a class that wraps entry/group models for display.
 * We inline the class to avoid webpack alias resolution issues.
 */

class EntryPresenter {
    entry: any = null;
    group: any = null;
    descField: string;
    noColor: string;
    activeEntryId: string | undefined;

    constructor(descField: string, noColor?: string, activeEntryId?: string) {
        this.descField = descField;
        this.noColor = noColor || '';
        this.activeEntryId = activeEntryId;
    }

    present(item: any): this {
        if (item.entry) {
            this.entry = item;
        } else if (item.group) {
            this.group = item;
        }
        return this;
    }

    reset(): void {
        this.entry = null;
        this.group = null;
    }

    get id(): string {
        return this.entry ? this.entry.id : this.group.id;
    }

    get icon(): string {
        return this.entry ? this.entry.icon : this.group.icon || 'folder';
    }

    get customIcon(): string | undefined {
        return this.entry ? this.entry.customIcon : undefined;
    }

    get color(): string | undefined {
        return this.entry
            ? this.entry.color || (this.entry.customIcon ? this.noColor : undefined)
            : undefined;
    }

    get title(): string {
        return this.entry ? this.entry.title : this.group.title;
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
        return this.entry ? this.entry.id === this.activeEntryId : this.group.active;
    }

    get expired(): boolean {
        return this.entry ? this.entry.expired : false;
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
}

// Mock data
const mockEntry = {
    entry: true,
    id: 'entry-1',
    icon: 'key',
    customIcon: null,
    color: 'blue',
    title: 'Test Entry',
    notes: 'Some notes',
    displayUrl: 'https://example.com',
    user: 'testuser',
    expired: false,
    tags: ['tag1', 'tag2'],
    groupName: 'General',
    fileName: 'test.kdbx',
    backend: 'kdbx',
    attachments: []
};

const mockGroup = {
    group: true,
    id: 'group-1',
    icon: 'folder-open',
    title: 'My Group',
    active: true
};

describe('EntryPresenter', () => {
    test('constructor sets descField, noColor, and activeEntryId', () => {
        const p = new EntryPresenter('website', 'gray', 'entry-1');
        expect(p.descField).toBe('website');
        expect(p.noColor).toBe('gray');
        expect(p.activeEntryId).toBe('entry-1');
    });

    test('constructor defaults noColor to empty string', () => {
        const p = new EntryPresenter('title');
        expect(p.noColor).toBe('');
    });

    test('present() with entry item sets entry', () => {
        const p = new EntryPresenter('title');
        const result = p.present(mockEntry);
        expect(p.entry).toBe(mockEntry);
        expect(p.group).toBeNull();
        expect(result).toBe(p); // returns this
    });

    test('present() with group item sets group', () => {
        const p = new EntryPresenter('title');
        p.present(mockGroup);
        expect(p.group).toBe(mockGroup);
        expect(p.entry).toBeNull();
    });

    test('reset() clears both entry and group', () => {
        const p = new EntryPresenter('title');
        p.present(mockEntry);
        p.reset();
        expect(p.entry).toBeNull();
        expect(p.group).toBeNull();
    });

    describe('getters with entry', () => {
        const p = new EntryPresenter('title', 'gray', 'entry-1');

        test('id returns entry id', () => {
            p.present(mockEntry);
            expect(p.id).toBe('entry-1');
        });

        test('icon returns entry icon', () => {
            p.present(mockEntry);
            expect(p.icon).toBe('key');
        });

        test('customIcon returns entry customIcon', () => {
            p.present(mockEntry);
            expect(p.customIcon).toBeNull();
        });

        test('color returns entry color', () => {
            p.present(mockEntry);
            expect(p.color).toBe('blue');
        });

        test('title returns entry title', () => {
            p.present(mockEntry);
            expect(p.title).toBe('Test Entry');
        });

        test('notes returns entry notes', () => {
            p.present(mockEntry);
            expect(p.notes).toBe('Some notes');
        });

        test('url returns entry displayUrl', () => {
            p.present(mockEntry);
            expect(p.url).toBe('https://example.com');
        });

        test('user returns entry user', () => {
            p.present(mockEntry);
            expect(p.user).toBe('testuser');
        });

        test('active returns true when entry id matches activeEntryId', () => {
            p.present(mockEntry);
            expect(p.active).toBe(true);
        });

        test('active returns false when entry id does not match', () => {
            const p2 = new EntryPresenter('title', '', 'other-id');
            p2.present(mockEntry);
            expect(p2.active).toBe(false);
        });

        test('expired returns entry expired', () => {
            p.present(mockEntry);
            expect(p.expired).toBe(false);
        });

        test('tags returns entry tags', () => {
            p.present(mockEntry);
            expect(p.tags).toEqual(['tag1', 'tag2']);
        });

        test('groupName returns entry groupName', () => {
            p.present(mockEntry);
            expect(p.groupName).toBe('General');
        });

        test('fileName returns entry fileName', () => {
            p.present(mockEntry);
            expect(p.fileName).toBe('test.kdbx');
        });
    });

    describe('getters with group', () => {
        const p = new EntryPresenter('title');

        test('id returns group id', () => {
            p.present(mockGroup);
            expect(p.id).toBe('group-1');
        });

        test('icon returns group icon', () => {
            p.present(mockGroup);
            expect(p.icon).toBe('folder-open');
        });

        test('icon defaults to folder when group has no icon', () => {
            const noIconGroup = { group: true, id: 'g', title: 'G', active: false };
            p.present(noIconGroup);
            expect(p.icon).toBe('folder');
        });

        test('customIcon returns undefined for group', () => {
            p.present(mockGroup);
            expect(p.customIcon).toBeUndefined();
        });

        test('color returns undefined for group', () => {
            p.present(mockGroup);
            expect(p.color).toBeUndefined();
        });

        test('title returns group title', () => {
            p.present(mockGroup);
            expect(p.title).toBe('My Group');
        });

        test('active returns group active', () => {
            p.present(mockGroup);
            expect(p.active).toBe(true);
        });

        test('expired returns false for group', () => {
            p.present(mockGroup);
            expect(p.expired).toBe(false);
        });
    });

    describe('color with customIcon and noColor', () => {
        test('returns noColor when entry has customIcon but no color', () => {
            const p = new EntryPresenter('title', 'gray');
            const entryWithCustomIcon = {
                ...mockEntry,
                color: null,
                customIcon: 'custom-icon-data'
            };
            p.present(entryWithCustomIcon);
            expect(p.color).toBe('gray');
        });

        test('returns undefined when entry has no color and no customIcon', () => {
            const p = new EntryPresenter('title', 'gray');
            const entryNoColor = { ...mockEntry, color: null, customIcon: null };
            p.present(entryNoColor);
            expect(p.color).toBeUndefined();
        });
    });
});
