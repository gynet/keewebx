import { findLoginInput, getNextFormPasswordInput, isFillableInput, setInputText } from './form-fill';
import {
    ContentScriptMessage,
    ContentScriptMessageAutoFill,
    ContentScriptReturn
} from 'common/content-script-interface';

declare global {
    interface Window {
        kwAutofillInstalled: boolean;
    }
}

if (window === window.top && !window.kwAutofillInstalled) {
    window.kwAutofillInstalled = true;

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (sender.id !== chrome.runtime.id) {
            return;
        }

        const response = run(message as ContentScriptMessage);
        if (response) {
            sendResponse(response);
        }

        function run(message: ContentScriptMessage): ContentScriptReturn | undefined {
            if (location.href !== message.url) {
                return;
            }
            switch (message.action) {
                case 'auto-fill':
                    autoFill(message);
                    break;
                case 'get-next-auto-fill-command':
                    return getNextAutoFillCommand(!!message.wholeForm);
            }
        }

        function getNextAutoFillCommand(wholeForm: boolean) {
            const active = document.activeElement;
            let input = isFillableInput(active) ? active : undefined;
            if (wholeForm && input?.type === 'password') {
                // A login picked in the popup fills the form from its username.
                const login = findLoginInput();
                if (login && login !== input && login.form === input.form) {
                    login.focus();
                    input = login;
                }
            }
            if (!input) {
                const found = findLoginInput();
                if (!found) {
                    return;
                }
                found.focus();
                input = found;
            }

            let nextCommand;
            if (input.type === 'password') {
                nextCommand = 'submit-password';
            } else {
                const passInput = getNextFormPasswordInput(input);
                if (passInput) {
                    nextCommand = 'submit-username-password';
                } else {
                    nextCommand = 'submit-username';
                }
            }
            return { nextCommand };
        }

        function autoFill(arg: ContentScriptMessageAutoFill) {
            const { text, password, submit } = arg;

            const input = document.activeElement;
            if (!text || !isFillableInput(input)) return;

            const form = input.form;
            const passwordInput = password ? getNextFormPasswordInput(input) : undefined;
            if (password && !passwordInput) return;

            setInputText(input, text);
            if (password && passwordInput) {
                if (!passwordInput.isConnected || !isFillableInput(passwordInput) ||
                    getNextFormPasswordInput(input) !== passwordInput) return;
                setInputText(passwordInput, password);
            }

            if (form && submit && input.form === form && isFillableInput(input)) {
                submitForm(form);
            }
        }

        function submitForm(form: HTMLFormElement) {
            const submitButton = <HTMLInputElement | undefined>(
                form.querySelector('input[type=submit],button[type=submit]')
            );
            if (typeof form.requestSubmit === 'function') {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-call
                form.requestSubmit(submitButton);
            } else if (submitButton) {
                submitButton.click();
            } else {
                const btn = document.createElement('input');
                btn.type = 'submit';
                btn.hidden = true;
                form.appendChild(btn);
                btn.click();
                form.removeChild(btn);
            }
        }
    });
}

export {};
