export function isVisible(el: HTMLElement): boolean {
    return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

/** With no field focused: the username field of the visible login form. */
export function findLoginInput(): HTMLInputElement | undefined {
    const pass = [...document.querySelectorAll<HTMLInputElement>('input[type=password]')].find(
        isVisible
    );
    if (!pass) {
        return undefined;
    }
    const inputs = [
        ...(pass.form ? pass.form.querySelectorAll('input') : document.querySelectorAll('input'))
    ];
    for (let ix = inputs.indexOf(pass) - 1; ix >= 0; ix--) {
        const candidate = inputs[ix];
        if (['text', 'email', 'tel', ''].includes(candidate.type) && isVisible(candidate)) {
            return candidate;
        }
    }
    return pass;
}

export function setInputText(input: HTMLInputElement, text: string) {
    // Bypass per-element value setters so framework value trackers observe the input event.
    const nativeValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
    )?.set;
    if (nativeValueSetter) {
        nativeValueSetter.call(input, text);
    } else {
        input.value = text;
    }
    input.dispatchEvent(
        new InputEvent('input', { inputType: 'insertFromPaste', data: text, bubbles: true })
    );
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

export function getNextFormPasswordInput(input: HTMLInputElement): HTMLInputElement | undefined {
    if (!input.form) {
        const inputs = [...document.querySelectorAll('input')];
        if (!inputs.includes(input)) {
            return undefined;
        }
        for (let ix = inputs.indexOf(input) + 1; ix < inputs.length; ix++) {
            const nextInput = inputs[ix] as HTMLInputElement;
            if (nextInput.form) {
                return undefined;
            }
            switch (nextInput.type) {
                case 'password':
                    return nextInput;
                case 'checkbox':
                case 'hidden':
                    continue;
                default:
                    return undefined;
            }
        }
        return undefined;
    }
    let found = false;
    for (const element of input.form.elements) {
        if (found) {
            if (element.tagName === 'INPUT') {
                const inputEl = element as HTMLInputElement;
                if (inputEl.type === 'password') {
                    return inputEl;
                }
            }
        }
        if (element === input) {
            found = true;
        }
    }
    return undefined;
}
