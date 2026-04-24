/**
 * KeeWebX icon registry — single source of truth for every Font Awesome
 * glyph the app renders.
 *
 * Why this exists:
 * - Prior art had icon names triplicated across icon-map.ts,
 *   _icon-font.scss and .hbs templates. Renaming or adding an icon
 *   required synchronised edits in three files with no validation,
 *   and silent drift was easy to introduce.
 * - Customising the icon set for a fork / theme should be "edit one
 *   list, rebuild". Nothing more.
 *
 * Consumers:
 * - TypeScript models + views: import ENTRY_ICONS directly.
 * - webpack build (fontawesome-loader, scss-add-icons-loader): parse
 *   this file to generate the woff2 font glyph table, the `$fa-var-*`
 *   SCSS variable declarations, and the `.fa-NAME:before { content }`
 *   CSS rules.
 * - Build validation: icons declared here but missing from
 *   @fortawesome/fontawesome-free fail the build.
 *
 * Adding an icon:
 * - Append its slug to APP_ICONS (alphabetical) or ENTRY_ICONS (if it
 *   should appear in the entry icon picker). Rebuild. That is the
 *   entire checklist.
 */

// Entry picker icons. Indexed by position in KDBX databases —
// position 0 is `key`, position 1 is `globe`, and so on. Any reorder
// or deletion corrupts existing databases. Append-only, forever.
export const ENTRY_ICONS = [
    'key',
    'globe',
    'exclamation-triangle',
    'server',
    'thumbtack',
    'comments',
    'puzzle-piece',
    'edit',
    'plug',
    'address-card',
    'paperclip',
    'camera',
    'wifi',
    'link',
    'battery-three-quarters',
    'barcode',
    'certificate',
    'bullseye',
    'desktop',
    'envelope',
    'cog',
    'clipboard',
    'paper-plane',
    'newspaper',
    'bolt',
    'inbox',
    'save',
    'hdd',
    'dot-circle',
    'user-lock',
    'terminal',
    'print',
    'project-diagram',
    'flag-checkered',
    'wrench',
    'laptop',
    'archive',
    'credit-card',
    'windows',
    'clock',
    'search',
    'flask',
    'gamepad',
    'trash',
    'sticky-note',
    'ban',
    'question-circle',
    'cube',
    'folder-o',
    'folder-open-o',
    'database',
    'unlock-alt',
    'lock',
    'check',
    'pencil-alt',
    'image',
    'book',
    'list-alt',
    'user-secret',
    'utensils',
    'home',
    'star',
    'linux',
    'map-pin',
    'apple',
    'wikipedia-w',
    'dollar-sign',
    'signature',
    'mobile'
] as const;

// All other Font Awesome icons referenced anywhere in the app —
// open screen, menu, toolbar, dialog buttons, details pane. Order is
// purely cosmetic (alphabetical keeps diffs tidy); codepoints are
// assigned at build time.
export const APP_ICONS = [
    'arrow-circle-left',
    'at',
    'bars',
    'bell',
    'bookmark',
    'bookmark-o',
    'caret-down',
    'check-square-o',
    'chevron-down',
    'chevron-left',
    'chrome',
    'circle',
    'circle-o',
    'clone',
    'cloud-download-alt',
    'code',
    'copy',
    'download',
    'dropbox',
    'edge',
    'ellipsis-h',
    'ellipsis-v',
    'exchange-alt',
    'exclamation-circle',
    'eye',
    'eye-slash',
    'file-alt',
    'file-alt-o',
    'file-archive',
    'file-audio',
    'file-code',
    'file-excel',
    'file-image',
    'file-pdf',
    'file-powerpoint',
    'file-video',
    'file-word',
    'filter',
    'fingerprint',
    'firefox-browser',
    'folder',
    'folder-open',
    'folder-plus',
    'github-alt',
    'google-drive',
    'html5',
    'info',
    'info-circle',
    'keeweb',
    'keyboard',
    'language',
    'level-down-alt',
    'long-arrow-alt-left',
    'long-arrow-alt-right',
    'magic',
    'minus-circle',
    'onedrive',
    'opera',
    'paint-brush',
    'plus',
    'qrcode',
    'question',
    'safari',
    'sign-out-alt',
    'sort-alpha-down',
    'sort-alpha-down-alt',
    'sort-amount-down',
    'sort-numeric-down',
    'sort-numeric-down-alt',
    'spinner',
    'square',
    'square-o',
    'sticky-note-o',
    'sync-alt',
    'tag',
    'tags',
    'th-large',
    'times',
    'times-circle',
    'titlebar-close',
    'titlebar-maximize',
    'titlebar-minimize',
    'titlebar-restore',
    'trash-alt',
    'twitter',
    'unlock',
    'usb',
    'usb-token',
    'user',
    'user-friends',
    'window-maximize'
] as const;

// Every FA icon the build system knows about. Derived — don't modify.
export const FA_ICONS: readonly string[] = [...ENTRY_ICONS, ...APP_ICONS];

export type EntryIconName = typeof ENTRY_ICONS[number];
export type AppIconName = typeof APP_ICONS[number];
export type FaIconName = EntryIconName | AppIconName;
