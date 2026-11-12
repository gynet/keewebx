import { describe, test, expect } from 'bun:test';

// Test GroupModel's pure logic without requiring the full dependency chain.
// GroupModel depends on kdbxweb, EntryModel, MenuItemModel, etc.
// We extract and test the algorithmic logic directly.

const DefaultAutoTypeSequence = '{USERNAME}{TAB}{PASSWORD}{ENTER}';

interface MockGroup {
    enableSearching: boolean | null;
    enableAutoType: boolean | null;
    autoTypeSeq: string | null;
    parentGroup: MockGroup | null;
}

function makeGroup(overrides?: Partial<MockGroup>): MockGroup {
    return {
        enableSearching: null,
        enableAutoType: null,
        autoTypeSeq: null,
        parentGroup: null,
        ...overrides
    };
}

// Replicate getEffectiveEnableSearching logic
function getEffectiveEnableSearching(grp: MockGroup | null): boolean {
    while (grp) {
        if (typeof grp.enableSearching === 'boolean') {
            return grp.enableSearching;
        }
        grp = grp.parentGroup;
    }
    return true;
}

// Replicate getEffectiveEnableAutoType logic
function getEffectiveEnableAutoType(grp: MockGroup | null): boolean {
    while (grp) {
        if (typeof grp.enableAutoType === 'boolean') {
            return grp.enableAutoType;
        }
        grp = grp.parentGroup;
    }
    return true;
}

// Replicate getEffectiveAutoTypeSeq logic
function getEffectiveAutoTypeSeq(grp: MockGroup | null): string {
    while (grp) {
        if (grp.autoTypeSeq) {
            return grp.autoTypeSeq;
        }
        grp = grp.parentGroup;
    }
    return DefaultAutoTypeSequence;
}

describe('GroupModel effective settings', () => {
    describe('getEffectiveEnableSearching', () => {
        test('returns own value when set to false', () => {
            const g = makeGroup({ enableSearching: false });
            expect(getEffectiveEnableSearching(g)).toBe(false);
        });

        test('returns own value when set to true', () => {
            const g = makeGroup({ enableSearching: true });
            expect(getEffectiveEnableSearching(g)).toBe(true);
        });

        test('defaults to true when null at all levels', () => {
            const parent = makeGroup({ enableSearching: null });
            const child = makeGroup({ enableSearching: null, parentGroup: parent });
            expect(getEffectiveEnableSearching(child)).toBe(true);
        });

        test('inherits from parent when null', () => {
            const parent = makeGroup({ enableSearching: false });
            const child = makeGroup({ enableSearching: null, parentGroup: parent });
            expect(getEffectiveEnableSearching(child)).toBe(false);
        });

        test('inherits from grandparent through chain', () => {
            const grandparent = makeGroup({ enableSearching: false });
            const parent = makeGroup({ enableSearching: null, parentGroup: grandparent });
            const child = makeGroup({ enableSearching: null, parentGroup: parent });
            expect(getEffectiveEnableSearching(child)).toBe(false);
        });

        test('child overrides parent', () => {
            const parent = makeGroup({ enableSearching: false });
            const child = makeGroup({ enableSearching: true, parentGroup: parent });
            expect(getEffectiveEnableSearching(child)).toBe(true);
        });
    });

    describe('getEffectiveEnableAutoType', () => {
        test('returns own value when set', () => {
            const g = makeGroup({ enableAutoType: false });
            expect(getEffectiveEnableAutoType(g)).toBe(false);
        });

        test('defaults to true', () => {
            const g = makeGroup({ enableAutoType: null });
            expect(getEffectiveEnableAutoType(g)).toBe(true);
        });

        test('inherits from parent', () => {
            const parent = makeGroup({ enableAutoType: false });
            const child = makeGroup({ enableAutoType: null, parentGroup: parent });
            expect(getEffectiveEnableAutoType(child)).toBe(false);
        });

        test('child overrides parent', () => {
            const parent = makeGroup({ enableAutoType: false });
            const child = makeGroup({ enableAutoType: true, parentGroup: parent });
            expect(getEffectiveEnableAutoType(child)).toBe(true);
        });
    });

    describe('getEffectiveAutoTypeSeq', () => {
        test('returns own sequence when set', () => {
            const g = makeGroup({ autoTypeSeq: '{PASSWORD}' });
            expect(getEffectiveAutoTypeSeq(g)).toBe('{PASSWORD}');
        });

        test('returns default when null', () => {
            const g = makeGroup({ autoTypeSeq: null });
            expect(getEffectiveAutoTypeSeq(g)).toBe('{USERNAME}{TAB}{PASSWORD}{ENTER}');
        });

        test('inherits from parent', () => {
            const parent = makeGroup({ autoTypeSeq: '{CUSTOM}' });
            const child = makeGroup({ autoTypeSeq: null, parentGroup: parent });
            expect(getEffectiveAutoTypeSeq(child)).toBe('{CUSTOM}');
        });

        test('child overrides parent', () => {
            const parent = makeGroup({ autoTypeSeq: '{PARENT}' });
            const child = makeGroup({ autoTypeSeq: '{CHILD}', parentGroup: parent });
            expect(getEffectiveAutoTypeSeq(child)).toBe('{CHILD}');
        });

        test('returns default with deep null chain', () => {
            const gp = makeGroup({ autoTypeSeq: null });
            const parent = makeGroup({ autoTypeSeq: null, parentGroup: gp });
            const child = makeGroup({ autoTypeSeq: null, parentGroup: parent });
            expect(getEffectiveAutoTypeSeq(child)).toBe(DefaultAutoTypeSequence);
        });
    });

    describe('getParentEffectiveAutoTypeSeq', () => {
        test('returns default when no parent', () => {
            const g = makeGroup({ parentGroup: null });
            const parentSeq = g.parentGroup ? getEffectiveAutoTypeSeq(g.parentGroup) : DefaultAutoTypeSequence;
            expect(parentSeq).toBe(DefaultAutoTypeSequence);
        });

        test('returns parent effective sequence', () => {
            const parent = makeGroup({ autoTypeSeq: '{PARENT_SEQ}' });
            const child = makeGroup({ parentGroup: parent });
            const parentSeq = child.parentGroup ? getEffectiveAutoTypeSeq(child.parentGroup) : DefaultAutoTypeSequence;
            expect(parentSeq).toBe('{PARENT_SEQ}');
        });
    });
});

describe('GroupModel matching logic', () => {
    interface MatchFilter {
        includeDisabled?: boolean;
        autoType?: boolean;
    }

    interface MatchableGroup {
        enableSearching: boolean | null;
        enableAutoType: boolean | null;
        isEntryTemplatesGroup: boolean;
        isRecycleBin: boolean;
    }

    function matches(group: MatchableGroup, filter?: MatchFilter): boolean {
        return (
            ((filter && filter.includeDisabled) ||
                (group.enableSearching !== false && !group.isEntryTemplatesGroup)) &&
            (!filter || !filter.autoType || group.enableAutoType !== false)
        );
    }

    test('matches normal group with no filter', () => {
        const group = { enableSearching: null, enableAutoType: null, isEntryTemplatesGroup: false, isRecycleBin: false };
        expect(matches(group)).toBe(true);
    });

    test('excludes group with searching disabled', () => {
        const group = { enableSearching: false, enableAutoType: null, isEntryTemplatesGroup: false, isRecycleBin: false };
        expect(matches(group)).toBe(false);
    });

    test('includes disabled group with includeDisabled', () => {
        const group = { enableSearching: false, enableAutoType: null, isEntryTemplatesGroup: false, isRecycleBin: false };
        expect(matches(group, { includeDisabled: true })).toBe(true);
    });

    test('excludes entry templates group', () => {
        const group = { enableSearching: null, enableAutoType: null, isEntryTemplatesGroup: true, isRecycleBin: false };
        expect(matches(group)).toBe(false);
    });

    test('includes entry templates with includeDisabled', () => {
        const group = { enableSearching: null, enableAutoType: null, isEntryTemplatesGroup: true, isRecycleBin: false };
        expect(matches(group, { includeDisabled: true })).toBe(true);
    });

    test('excludes group with autoType disabled when filter requires it', () => {
        const group = { enableSearching: null, enableAutoType: false, isEntryTemplatesGroup: false, isRecycleBin: false };
        expect(matches(group, { autoType: true })).toBe(false);
    });

    test('includes group with autoType enabled when filter requires it', () => {
        const group = { enableSearching: null, enableAutoType: true, isEntryTemplatesGroup: false, isRecycleBin: false };
        expect(matches(group, { autoType: true })).toBe(true);
    });
});
