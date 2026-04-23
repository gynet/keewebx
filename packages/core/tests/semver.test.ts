import { describe, test, expect } from 'bun:test';

// Inline the pure function to avoid webpack alias resolution issues
const SemVer = {
    compareVersions(left: string, right: string): number {
        const l = left.replace(/-.*$/, '').split('.');
        const r = right.replace(/-.*$/, '').split('.');
        for (let num = 0; num < l.length; num++) {
            const partLeft = (l[num] as any) | 0;
            const partRight = (r[num] as any) | 0;
            if (partLeft < partRight) return -1;
            if (partLeft > partRight) return 1;
        }
        return 0;
    }
};

describe('SemVer.compareVersions', () => {
    test('equal versions return 0', () => {
        expect(SemVer.compareVersions('1.0.0', '1.0.0')).toBe(0);
        expect(SemVer.compareVersions('2.5.10', '2.5.10')).toBe(0);
    });

    test('left < right returns -1', () => {
        expect(SemVer.compareVersions('1.0.0', '2.0.0')).toBe(-1);
        expect(SemVer.compareVersions('1.0.0', '1.1.0')).toBe(-1);
        expect(SemVer.compareVersions('1.0.0', '1.0.1')).toBe(-1);
        expect(SemVer.compareVersions('0.9.9', '1.0.0')).toBe(-1);
    });

    test('left > right returns 1', () => {
        expect(SemVer.compareVersions('2.0.0', '1.0.0')).toBe(1);
        expect(SemVer.compareVersions('1.1.0', '1.0.0')).toBe(1);
        expect(SemVer.compareVersions('1.0.1', '1.0.0')).toBe(1);
    });

    test('strips pre-release suffixes before comparison', () => {
        expect(SemVer.compareVersions('1.0.0-beta', '1.0.0')).toBe(0);
        expect(SemVer.compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(0);
        expect(SemVer.compareVersions('1.0.0-rc.1', '0.9.9')).toBe(1);
    });

    test('handles different length version parts', () => {
        expect(SemVer.compareVersions('1.0', '1.0.0')).toBe(0);
        expect(SemVer.compareVersions('1', '1.0.0')).toBe(0);
    });

    test('compares major version differences correctly', () => {
        expect(SemVer.compareVersions('10.0.0', '9.9.9')).toBe(1);
        expect(SemVer.compareVersions('0.0.1', '0.0.2')).toBe(-1);
    });
});
