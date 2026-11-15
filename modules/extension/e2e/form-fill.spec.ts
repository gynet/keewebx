import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';

declare global {
    interface Window {
        formFill: typeof import('../src/content/form-fill');
    }
}

// Exercise the actual shared module in a browser, without installing the extension.
function compile(file: string): string {
    return ts.transpileModule(readFileSync(resolve(__dirname, '../src/content', file), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
    }).outputText;
}

const helpers = compile('form-fill.ts');
const contentPage = compile('content-page.ts');

test.beforeEach(async ({ page }) => {
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({
        content: `(function () { const exports = {}; ${helpers}; window.formFill = exports; })();`
    });
});

test('visibility uses actual layout and computed visibility', async ({ page }) => {
    await page.setContent(`
        <input id="visible"><input style="display:none">
        <input style="visibility:hidden"><input type="hidden">
    `);
    expect(
        await page.evaluate(() => [
            ...Array.from(document.querySelectorAll('input'), window.formFill.isVisible),
            window.formFill.isVisible(document.createElement('input'))
        ])
    ).toEqual([true, false, false, false, false]);
});

for (const type of ['text', 'email', 'tel']) {
    test(`finds the nearest visible ${type} login in the password's form`, async ({ page }) => {
        await page.setContent(`
            <form style="display:none"><input><input type="password"></form>
            <form><input id="earlier"><input id="login" type="${type}">
                <input type="number"><input type="checkbox">
                <input style="visibility:hidden"><input type="password" id="password">
            </form>
        `);
        expect(await page.evaluate(() => window.formFill.findLoginInput()?.id)).toBe('login');
    });
}

test('finds an unowned login and falls back to its visible password', async ({ page }) => {
    await page.setContent('<input id="login"><input type="password" id="password">');
    expect(await page.evaluate(() => window.formFill.findLoginInput()?.id)).toBe('login');
    await page.locator('#login').evaluate((element) => element.remove());
    expect(await page.evaluate(() => window.formFill.findLoginInput()?.id)).toBe('password');
    await page.locator('#password').evaluate((element) => element.remove());
    expect(await page.evaluate(() => window.formFill.findLoginInput()?.id)).toBeUndefined();
});

test('does not select a username from another form', async ({ page }) => {
    await page.setContent(
        '<form><input id="other"></form><form><input type="password" id="password"></form>'
    );
    expect(await page.evaluate(() => window.formFill.findLoginInput()?.id)).toBe('password');
});

test('in a form, finds the following password across intervening controls', async ({ page }) => {
    await page.setContent(`
        <form><input type="password" id="before"><input id="login">
            <button>Continue</button><input type="text"><input type="password" id="after">
        </form>
    `);
    expect(
        await page.evaluate(
            () =>
                window.formFill.getNextFormPasswordInput(
                    document.querySelector<HTMLInputElement>('#login')!
                )?.id
        )
    ).toBe('after');
    expect(
        await page.evaluate(
            () =>
                window.formFill.getNextFormPasswordInput(
                    document.querySelector<HTMLInputElement>('#after')!
                )?.id
        )
    ).toBeUndefined();
});

test('outside a form, skips checkbox and hidden inputs before the password', async ({ page }) => {
    await page.setContent(
        '<input id="login"><input type="checkbox"><input type="hidden"><input type="password" id="password">'
    );
    expect(
        await page.evaluate(
            () =>
                window.formFill.getNextFormPasswordInput(
                    document.querySelector<HTMLInputElement>('#login')!
                )?.id
        )
    ).toBe('password');
});

for (const middle of ['<input type="text">', '<form><input type="password"></form>']) {
    test(`outside a form, stops at ${middle}`, async ({ page }) => {
        await page.setContent(`<input id="login">${middle}<input type="password">`);
        expect(
            await page.evaluate(
                () =>
                    window.formFill.getNextFormPasswordInput(
                        document.querySelector<HTMLInputElement>('#login')!
                    )?.id
            )
        ).toBeUndefined();
    });
}

test('does not find a following password for a detached input', async ({ page }) => {
    await page.setContent('<input type="password">');
    expect(
        await page.evaluate(() =>
            window.formFill.getNextFormPasswordInput(document.createElement('input'))
        )
    ).toBeUndefined();
});

test('sets the value and bubbles the existing input and change events in order', async ({
    page
}) => {
    await page.setContent('<form><input id="login"></form>');
    expect(
        await page.evaluate(() => {
            const input = document.querySelector('input')!;
            const events: unknown[] = [];
            for (const type of ['input', 'change']) {
                document.querySelector('form')!.addEventListener(type, (event) => {
                    events.push({
                        type: event.type,
                        value: input.value,
                        bubbles: event.bubbles,
                        ...(event instanceof InputEvent
                            ? { data: event.data, inputType: event.inputType }
                            : {})
                    });
                });
            }
            window.formFill.setInputText(input, '用户@example.com');
            return { value: input.value, events };
        })
    ).toEqual({
        value: '用户@example.com',
        events: [
            {
                type: 'input',
                value: '用户@example.com',
                bubbles: true,
                data: '用户@example.com',
                inputType: 'insertFromPaste'
            },
            { type: 'change', value: '用户@example.com', bubbles: true }
        ]
    });
});

test('bypasses a React-style value tracker so its input handler observes the change', async ({
    page
}) => {
    await page.setContent('<input value="before">');
    expect(
        await page.evaluate(() => {
            const input = document.querySelector('input')!;
            const descriptor = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                'value'
            )!;
            let tracked = input.value;
            let state = input.value;
            let setterCalls = 0;
            Object.defineProperty(input, 'value', {
                get() {
                    return descriptor.get!.call(this);
                },
                set(value: string) {
                    setterCalls++;
                    tracked = value;
                    descriptor.set!.call(this, value);
                }
            });
            input.addEventListener('input', () => {
                if (tracked !== input.value) {
                    tracked = state = input.value;
                }
            });
            window.formFill.setInputText(input, 'after');
            const bypassedTracker = setterCalls === 0;
            // A controlled render must retain the value observed by the event handler.
            input.value = state;
            return { bypassedTracker, state, value: input.value };
        })
    ).toEqual({ bypassedTracker: true, state: 'after', value: 'after' });
});

test('content script retains its guarded listener, form filling and submission', async ({
    page
}) => {
    await page.setContent(
        '<form><input id="login"><input type="password" id="password"><button type="submit">Go</button></form>'
    );
    expect(
        await page.evaluate((source) => {
            type Listener = (
                message: unknown,
                sender: { id: string },
                respond: (response: unknown) => void
            ) => void;
            const listeners: Listener[] = [];
            Object.assign(window, {
                chrome: {
                    runtime: {
                        id: 'extension',
                        onMessage: { addListener: (listener: Listener) => listeners.push(listener) }
                    }
                }
            });
            const load = () =>
                new Function('exports', 'require', source)({}, (name: string) => {
                    if (name !== './form-fill') throw new Error(`Unexpected import: ${name}`);
                    return window.formFill;
                });
            load();
            load();
            const responses: unknown[] = [];
            const send = (message: object, id = 'extension') =>
                listeners[0]({ url: location.href, ...message }, { id }, (response) =>
                    responses.push(response)
                );
            let submissions = 0;
            document.querySelector('form')!.addEventListener('submit', (event) => {
                event.preventDefault();
                submissions++;
            });
            send({ action: 'get-next-auto-fill-command' }, 'other-extension');
            send({ action: 'get-next-auto-fill-command', url: 'https://wrong.example' });
            const ignored = responses.length === 0 && document.activeElement?.tagName === 'BODY';
            send({ action: 'get-next-auto-fill-command' });
            send({ action: 'auto-fill', text: 'alice', password: 'secret', submit: true });
            const values = [...document.querySelectorAll('input')].map((input) => input.value);
            send({ action: 'get-next-auto-fill-command', wholeForm: true });
            return {
                ignored,
                listeners: listeners.length,
                responses,
                values,
                submissions,
                focused: document.activeElement?.id
            };
        }, contentPage)
    ).toEqual({
        ignored: true,
        listeners: 1,
        responses: [
            { nextCommand: 'submit-username-password' },
            { nextCommand: 'submit-username-password' }
        ],
        values: ['alice', 'secret'],
        submissions: 1,
        focused: 'login'
    });
});
