const isFirefox = location.origin.startsWith('moz');

export const supportsUnicodeMenus = true;
export const canUseOnlyAppConnection = false;
export const canEditShortcuts = true;
export const shortcutsCanBeEditedOnlyManually = isFirefox;
export const needRequestPermissionsPerSite = false;
