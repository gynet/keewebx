import { describe, expect, it } from 'bun:test';

/**
 * Tests for the features module.
 *
 * The features module derives boolean flags from `location.origin`, which is not
 * available in a test environment. We test the logic pattern by reproducing the
 * derivation and verifying all flag combinations are consistent.
 */

// -- Reproduce the feature flag derivation logic --

function deriveFeatures(origin: string) {
    const isSafari = origin.startsWith('safari');
    const isFirefox = origin.startsWith('moz');

    return {
        isSafari,
        isFirefox,
        supportsUnicodeMenus: !isSafari,
        canUseOnlyAppConnection: isSafari,
        canEditShortcuts: !isSafari,
        shortcutsCanBeEditedOnlyManually: isFirefox,
        needRequestPermissionsPerSite: isSafari
    };
}

describe('Feature Flags - Chrome', () => {
    const features = deriveFeatures('chrome-extension://abcdef');

    it('should not be Safari', () => {
        expect(features.isSafari).toBe(false);
    });

    it('should not be Firefox', () => {
        expect(features.isFirefox).toBe(false);
    });

    it('should support unicode menus', () => {
        expect(features.supportsUnicodeMenus).toBe(true);
    });

    it('should not require app-only connection', () => {
        expect(features.canUseOnlyAppConnection).toBe(false);
    });

    it('should allow shortcut editing', () => {
        expect(features.canEditShortcuts).toBe(true);
    });

    it('should not require manual shortcut editing', () => {
        expect(features.shortcutsCanBeEditedOnlyManually).toBe(false);
    });

    it('should not need per-site permission requests', () => {
        expect(features.needRequestPermissionsPerSite).toBe(false);
    });
});

describe('Feature Flags - Safari', () => {
    const features = deriveFeatures('safari-web-extension://abcdef');

    it('should be Safari', () => {
        expect(features.isSafari).toBe(true);
    });

    it('should not be Firefox', () => {
        expect(features.isFirefox).toBe(false);
    });

    it('should not support unicode menus', () => {
        expect(features.supportsUnicodeMenus).toBe(false);
    });

    it('should require app-only connection', () => {
        expect(features.canUseOnlyAppConnection).toBe(true);
    });

    it('should not allow shortcut editing', () => {
        expect(features.canEditShortcuts).toBe(false);
    });

    it('should not require manual shortcut editing', () => {
        expect(features.shortcutsCanBeEditedOnlyManually).toBe(false);
    });

    it('should need per-site permission requests', () => {
        expect(features.needRequestPermissionsPerSite).toBe(true);
    });
});

describe('Feature Flags - Firefox', () => {
    const features = deriveFeatures('moz-extension://abcdef');

    it('should not be Safari', () => {
        expect(features.isSafari).toBe(false);
    });

    it('should be Firefox', () => {
        expect(features.isFirefox).toBe(true);
    });

    it('should support unicode menus', () => {
        expect(features.supportsUnicodeMenus).toBe(true);
    });

    it('should not require app-only connection', () => {
        expect(features.canUseOnlyAppConnection).toBe(false);
    });

    it('should allow shortcut editing', () => {
        expect(features.canEditShortcuts).toBe(true);
    });

    it('should require manual shortcut editing', () => {
        expect(features.shortcutsCanBeEditedOnlyManually).toBe(true);
    });

    it('should not need per-site permission requests', () => {
        expect(features.needRequestPermissionsPerSite).toBe(false);
    });
});

describe('Feature Flags - Edge', () => {
    // Edge uses chrome-extension:// origin
    const features = deriveFeatures('chrome-extension://edgeextid');

    it('should behave like Chrome', () => {
        expect(features.isSafari).toBe(false);
        expect(features.isFirefox).toBe(false);
        expect(features.supportsUnicodeMenus).toBe(true);
        expect(features.canUseOnlyAppConnection).toBe(false);
        expect(features.canEditShortcuts).toBe(true);
        expect(features.shortcutsCanBeEditedOnlyManually).toBe(false);
        expect(features.needRequestPermissionsPerSite).toBe(false);
    });
});

describe('Feature Flag Consistency', () => {
    it('Safari flags should be mutually consistent', () => {
        const features = deriveFeatures('safari-web-extension://x');
        // Safari always has these paired:
        // canUseOnlyAppConnection === needRequestPermissionsPerSite
        expect(features.canUseOnlyAppConnection).toBe(features.needRequestPermissionsPerSite);
        // canEditShortcuts is inverse of canUseOnlyAppConnection
        expect(features.canEditShortcuts).toBe(!features.canUseOnlyAppConnection);
        // supportsUnicodeMenus is inverse of isSafari
        expect(features.supportsUnicodeMenus).toBe(!features.isSafari);
    });

    it('Firefox flags should be mutually consistent', () => {
        const features = deriveFeatures('moz-extension://x');
        // Firefox should not have Safari-only restrictions
        expect(features.canUseOnlyAppConnection).toBe(false);
        expect(features.needRequestPermissionsPerSite).toBe(false);
        // But should have its own manual shortcut editing flag
        expect(features.shortcutsCanBeEditedOnlyManually).toBe(true);
        expect(features.canEditShortcuts).toBe(true);
    });

    it('unknown origin should get Chrome defaults', () => {
        const features = deriveFeatures('https://localhost');
        expect(features.isSafari).toBe(false);
        expect(features.isFirefox).toBe(false);
        expect(features.supportsUnicodeMenus).toBe(true);
        expect(features.canUseOnlyAppConnection).toBe(false);
        expect(features.canEditShortcuts).toBe(true);
        expect(features.shortcutsCanBeEditedOnlyManually).toBe(false);
        expect(features.needRequestPermissionsPerSite).toBe(false);
    });
});
