import { findLoginInput, getNextFormPasswordInput, isVisible, setInputText } from '../../src/content/form-fill';

export function eligible(input: unknown): input is HTMLInputElement {
    return input instanceof HTMLInputElement && input.ownerDocument === document && input.isConnected &&
        !input.matches(':disabled') && !input.readOnly && !input.closest('[inert],[aria-hidden="true"]') && isVisible(input) &&
        ['password', 'text', 'email', 'tel'].includes(input.type) &&
        !/(?:^|\s)(?:new-password|one-time-code)(?:\s|$)/i.test(input.autocomplete);
}
export interface Targets { href: string; user?: HTMLInputElement; password?: HTMLInputElement; userForm?: HTMLFormElement | null; passwordForm?: HTMLFormElement | null; userType?: string; passwordType?: string; }

export function targets(anchor?: HTMLInputElement): Targets {
    const input = eligible(anchor) ? anchor : findLoginInput();
    if (!eligible(input)) throw new Error('Click a username or password field on this website first.');
    let user: HTMLInputElement | undefined;
    let password: HTMLInputElement | undefined;
    if (input.type === 'password') {
        password = input;
        const fields = [...(input.form ? input.form.querySelectorAll('input') : document.querySelectorAll('input'))];
        user = fields.slice(0, fields.indexOf(input)).reverse().find(field => eligible(field) && field.type !== 'password');
    } else {
        user = input;
        const next = getNextFormPasswordInput(input);
        if (next && !eligible(next)) throw new Error('The password field in this form cannot be filled.');
        password = next;
        if (!password && input.type !== 'email' && !/(?:^|\s)username(?:\s|$)/i.test(input.autocomplete)) {
            throw new Error('No login password field was found. Click the correct login field first.');
        }
    }
    return { href: location.href, user, password, userForm: user?.form, passwordForm: password?.form, userType: user?.type, passwordType: password?.type };
}
export function assertTargets(target: Targets): void {
    if (location.href !== target.href ||
        (target.user && (!eligible(target.user) || target.user.form !== target.userForm || target.user.type !== target.userType)) ||
        (target.password && (!eligible(target.password) || target.password.form !== target.passwordForm || target.password.type !== target.passwordType))) {
        throw new Error('The login page or form changed. Select an account again.');
    }
}
export function fill(target: Targets, values: Record<string, string>, assertLive: () => void = () => {}): void {
    if (target.user && typeof values.user !== 'string') throw new Error('KeeWebX did not return a username.');
    if (target.password && typeof values.password !== 'string') throw new Error('KeeWebX did not return a password.');
    assertLive(); assertTargets(target);
    if (target.user && typeof values.user === 'string') setInputText(target.user, values.user);
    // Input/change handlers can synchronously navigate or replace the form.
    // Check the destination and operation again after those handlers return.
    assertLive(); assertTargets(target);
    if (target.password) {
        setInputText(target.password, values.password);
    }
}
