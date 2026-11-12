import { AppSettingsModel } from 'models/app-settings-model';

interface CopyResult {
    success: boolean;
    seconds?: number;
}

const CopyPaste = {
    simpleCopy: false,

    copy(text: string): CopyResult | false {
        try {
            navigator.clipboard.writeText(text).then(() => {
                const clipboardSeconds = AppSettingsModel.clipboardSeconds;
                if (clipboardSeconds > 0) {
                    setTimeout(() => {
                        navigator.clipboard.readText().then((current) => {
                            if (current === text) {
                                navigator.clipboard.writeText('');
                            }
                        });
                    }, clipboardSeconds * 1000);
                }
            });
            return { success: true, seconds: AppSettingsModel.clipboardSeconds };
        } catch (e) {
            try {
                if (document.execCommand('copy')) {
                    return { success: true };
                }
            } catch (_e) {}
            return false;
        }
    },

    createHiddenInput(text: string): void {
        const hiddenInput = ($('<input/>') as JQuery<HTMLInputElement>)
            .val(text)
            .attr({ type: 'text', 'class': 'hide-by-pos' })
            .appendTo(document.body);
        (hiddenInput[0] as HTMLInputElement).selectionStart = 0;
        (hiddenInput[0] as HTMLInputElement).selectionEnd = text.length;
        hiddenInput.focus();
        hiddenInput.on({
            'copy cut paste'() {
                setTimeout(() => hiddenInput.blur(), 0);
            },
            blur() {
                hiddenInput.remove();
            }
        });
    },

    copyHtml(html: string): boolean {
        const el = document.createElement('div');
        el.style.userSelect = 'auto';
        el.style.webkitUserSelect = 'auto';
        (el.style as CSSStyleDeclaration & { mozUserSelect?: string }).mozUserSelect = 'auto';
        el.innerHTML = html;
        document.body.appendChild(el);

        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);

        const result = document.execCommand('copy');

        el.remove();
        return result;
    }
};

export { CopyPaste };
export type { CopyResult };
