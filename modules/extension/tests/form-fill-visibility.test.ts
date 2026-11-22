import { expect, test } from 'bun:test';
import { isVisible } from '../src/content/form-fill';

test('autofill requires visible pixels inside the viewport and clipping ancestors', () => {
    const visible = {
        opacity: '1', visibility: 'visible', overflowX: 'visible', overflowY: 'visible',
        getPropertyValue: () => 'visible'
    };
    const clip = { left: 10, top: 10, right: 90, bottom: 90 };
    const parent = { parentElement: null, style: { ...visible, overflowX: 'hidden' }, getBoundingClientRect: () => clip };
    let rect = { left: 20, top: 20, right: 70, bottom: 40 };
    const field = { parentElement: parent, style: visible, closest: () => null, getBoundingClientRect: () => rect };
    const globals = {
        window: { visualViewport: { offsetLeft: 0, offsetTop: 0, width: 100, height: 100 } },
        document: { body: {}, documentElement: {} },
        getComputedStyle: (element: { style: typeof visible }) => element.style
    };
    const originals = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
    try {
        const input = field as unknown as HTMLElement;
        expect(isVisible(input)).toBe(true);
        parent.style.opacity = '0';
        expect(isVisible(input)).toBe(false);
        parent.style.opacity = '1';
        rect = { left: 20, top: 20, right: 21, bottom: 40 };
        expect(isVisible(input)).toBe(false);
        rect = { left: 20, top: 120, right: 70, bottom: 140 };
        expect(isVisible(input)).toBe(false);
        rect = { left: 92, top: 20, right: 99, bottom: 40 };
        expect(isVisible(input)).toBe(false);
    } finally {
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
});
