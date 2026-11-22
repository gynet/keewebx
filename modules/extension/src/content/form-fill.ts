export function isVisible(el: HTMLElement): boolean {
    if (el.closest('[hidden], [inert]') || getComputedStyle(el).visibility !== 'visible') return false;
    const rect = el.getBoundingClientRect();
    const viewport = window.visualViewport;
    const x = viewport?.offsetLeft ?? 0;
    const y = viewport?.offsetTop ?? 0;
    let left = Math.max(rect.left, x);
    let top = Math.max(rect.top, y);
    let right = Math.min(rect.right, x + (viewport?.width ?? innerWidth));
    let bottom = Math.min(rect.bottom, y + (viewport?.height ?? innerHeight));
    for (let element: HTMLElement | null = el; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (Number(style.opacity) === 0 || style.getPropertyValue('content-visibility') === 'hidden') return false;
        if (element === el || element === document.body || element === document.documentElement) continue;
        const clip = element.getBoundingClientRect();
        if (/^(?:auto|scroll|hidden|clip)$/.test(style.overflowX)) {
            left = Math.max(left, clip.left);
            right = Math.min(right, clip.right);
        }
        if (/^(?:auto|scroll|hidden|clip)$/.test(style.overflowY)) {
            top = Math.max(top, clip.top);
            bottom = Math.min(bottom, clip.bottom);
        }
    }
    return right - left > 1 && bottom - top > 1;
}

export function isFillableInput(input: Element | null): input is HTMLInputElement {
    return input instanceof HTMLInputElement &&
        ['text', 'email', 'tel', 'url', 'search', 'number', 'password'].includes(input.type) &&
        !input.matches(':disabled, [readonly]') && isVisible(input);
}

/** With no field focused: the username field of the visible login form. */
export function findLoginInput(): HTMLInputElement | undefined {
    const pass = [...document.querySelectorAll<HTMLInputElement>('input[type=password]')].find(
        isFillableInput
    );
    if (!pass) {
        return undefined;
    }
    const inputs = [
        ...(pass.form ? pass.form.querySelectorAll('input') : document.querySelectorAll('input'))
    ];
    for (let ix = inputs.indexOf(pass) - 1; ix >= 0; ix--) {
        const candidate = inputs[ix];
        if (['text', 'email', 'tel', ''].includes(candidate.type) && isFillableInput(candidate)) {
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
                    return isFillableInput(nextInput) ? nextInput : undefined;
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
                    return isFillableInput(inputEl) ? inputEl : undefined;
                }
            }
        }
        if (element === input) {
            found = true;
        }
    }
    return undefined;
}
