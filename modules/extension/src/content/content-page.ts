import { findLoginInput, getNextFormPasswordInput, setInputText } from './form-fill';
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

if (!window.kwAutofillInstalled) {
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
            let input = <HTMLInputElement>document.activeElement;
            if (wholeForm && input?.tagName === 'INPUT' && input.type === 'password') {
                // A login picked in the popup fills the form from its username.
                const login = findLoginInput();
                if (login && login !== input && login.form === input.form) {
                    login.focus();
                    input = login;
                }
            }
            if (input?.tagName !== 'INPUT') {
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

            let input = <HTMLInputElement | undefined>document.activeElement;
            if (!input) {
                return;
            }

            if (!text) {
                return;
            }

            setInputText(input, text);

            const form = input.form;

            if (password) {
                input = getNextFormPasswordInput(input);
                if (!input) {
                    return;
                }

                input.focus();
                setInputText(input, password);
            }

            if (form && submit) {
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
