export const shortcutKeys = {
    open: 'o', save: 's', lock: 'l', generator: 'g', settings: ',', find: 'f',
    password: 'c', username: 'b', website: 'u', otp: '2', create: 'n', all: 'a', color: 'c', trash: 'd'
} as const;

export const isApplePlatform = (platform: string) => /Mac|iPhone|iPad/.test(platform);
export interface KeyboardShortcut {
    id: string;
    label: string;
    keys: readonly string[];
    when: string;
    policy?: 'canOpen' | 'canOpenGenerator' | 'canOpenSettings';
}

/** Labels describe implemented New actions, including their focus restrictions. */
export const keyboardShortcuts: readonly KeyboardShortcut[] = [
    { id: 'open', label: 'Open a vault', keys: ['Mod', shortcutKeys.open], when: 'Outside text fields; local file picker on the start screen, enabled sources in the open workspace' },
    { id: 'save', label: 'Apply valid drafts and save vaults', keys: ['Mod', shortcutKeys.save], when: 'Open workspace, including editors' },
    { id: 'lock', label: 'Save and lock', keys: ['Mod', shortcutKeys.lock], when: 'Open workspace, including editors' },
    { id: 'generator', label: 'Password generator', keys: ['Mod', shortcutKeys.generator], when: 'Start screen or open workspace, outside editors', policy: 'canOpenGenerator' },
    { id: 'settings', label: 'Settings', keys: ['Mod', shortcutKeys.settings], when: 'Start screen or open workspace, outside editors', policy: 'canOpenSettings' },
    { id: 'find', label: 'Focus and select search', keys: ['Mod', shortcutKeys.find], when: 'Visible vault; asks before discarding drafts' },
    { id: 'type-search', label: 'Start searching', keys: ['Type text'], when: 'Visible vault, outside text fields and without selected text' },
    { id: 'clear', label: 'Clear search', keys: ['Escape'], when: 'Search is focused' },
    { id: 'recent-focus', label: 'Navigate recent vaults', keys: ['ArrowUp / ArrowDown / Home / End'], when: 'A recent vault button is focused; Enter or Space selects it' },
    { id: 'next', label: 'Next entry', keys: ['ArrowDown'], when: 'Visible vault outside editors; also from search' },
    { id: 'previous', label: 'Previous entry', keys: ['ArrowUp'], when: 'Visible vault outside editors; also from search' },
    { id: 'first', label: 'First entry', keys: ['Home'], when: 'Visible vault outside text fields' },
    { id: 'last', label: 'Last entry', keys: ['End'], when: 'Visible vault outside text fields' },
    { id: 'search-open', label: 'Open next search result', keys: ['Enter'], when: 'Search is focused' },
    { id: 'create', label: 'Create an entry', keys: ['Alt', shortcutKeys.create], when: 'Visible vault, writable destination, outside text fields' },
    { id: 'all', label: 'All items', keys: ['Alt', shortcutKeys.all], when: 'Visible vault outside text fields' },
    { id: 'color', label: 'Colored items', keys: ['Alt', shortcutKeys.color], when: 'Visible vault outside text fields' },
    { id: 'trash', label: 'Trash', keys: ['Alt', shortcutKeys.trash], when: 'Visible vault outside text fields' },
    { id: 'password', label: 'Copy password', keys: ['Mod', shortcutKeys.password], when: 'Selected visible entry; native text selection and editing take precedence' },
    { id: 'username', label: 'Copy username', keys: ['Mod', shortcutKeys.username], when: 'Selected visible entry; outside text fields and text selection' },
    { id: 'website', label: 'Copy website', keys: ['Mod', shortcutKeys.website], when: 'Selected visible entry; outside text fields and text selection' },
    { id: 'otp', label: 'Copy current one-time code', keys: ['Alt', shortcutKeys.otp], when: 'Selected visible entry with OTP; outside text fields and text selection' },
    { id: 'attachment-delete', label: 'Remove focused attachment', keys: ['Mod', 'Delete / Backspace'], when: 'Attachment action is focused; confirmation required' },
    { id: 'cancel-editor', label: 'Cancel editing', keys: ['Escape'], when: 'Entry or notes editor; asks before discarding changes' },
    { id: 'save-notes', label: 'Apply inline notes', keys: ['Mod', 'Enter'], when: 'Inline notes editor; Enter alone inserts a newline' },
    { id: 'next-field', label: 'Next field', keys: ['Tab'], when: 'Forms retain drafts while moving focus' },
    { id: 'previous-field', label: 'Previous field', keys: ['Shift', 'Tab'], when: 'Forms retain drafts while moving focus' }
];

export function formatShortcut(shortcut: Pick<KeyboardShortcut, 'keys'>, platform: string): string {
    const apple = isApplePlatform(platform);
    return shortcut.keys.map(key => key === 'Mod' ? apple ? 'Command' : 'Ctrl'
        : key === 'Alt' && apple ? 'Option' : key.length === 1 ? key.toUpperCase() : key).join(' + ');
}

export function keyboardShortcutHelp(platform: string) {
    return keyboardShortcuts.map(shortcut => ({ ...shortcut, shortcut: formatShortcut(shortcut, platform) }));
}
