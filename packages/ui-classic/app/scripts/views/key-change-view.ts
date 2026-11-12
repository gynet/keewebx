import { View } from 'framework/views/view';
import { SecureInput } from 'comp/browser/secure-input';
import { Alerts } from 'comp/ui/alerts';
import { Keys } from 'const/keys';
import { Locale } from 'util/locale';
import { InputFx } from 'util/ui/input-fx';
import template from 'templates/key-change.hbs';

const loc = Locale as Record<string, string | undefined>;

// Model passed in by app-model.ts when a key change is requested.
// Fields are minimal — just what this view reads.
interface KeyChangeViewModel {
    file: {
        name: string;
        keyFileName?: string | null;
    };
    expired: boolean;
}

class KeyChangeView extends View {
    parent = '.app__body';

    template = template;

    events: Record<string, string> = {
        'keydown .key-change__pass': 'inputKeydown',
        'keydown .key-change__pass-repeat': 'inputKeydown',
        'click .key-change__keyfile': 'keyFileClicked',
        'change .key-change__file': 'keyFileSelected',
        'click .key-change__btn-ok': 'accept',
        'click .key-change__btn-cancel': 'cancel'
    };

    passwordInput: SecureInput;
    passwordRepeatInput: SecureInput | null = null;
    inputEl: JQuery<HTMLElement> | null = null;
    keyFileName: string | null = null;
    keyFileData: ArrayBuffer | null = null;
    keyFile: null = null;

    declare model: KeyChangeViewModel;

    constructor(model: KeyChangeViewModel) {
        super(model);
        this.passwordInput = new SecureInput();
    }

    render(): this | undefined {
        this.keyFileName = this.model.file.keyFileName || null;
        this.keyFileData = null;
        const repeat = this.model.expired;
        super.render({
            fileName: this.model.file.name,
            keyFileName: this.model.file.keyFileName,
            title: this.model.expired
                ? loc.keyChangeTitleExpired
                : loc.keyChangeTitleRemote,
            message: this.model.expired
                ? loc.keyChangeMessageExpired
                : loc.keyChangeMessageRemote,
            repeat
        });
        this.$el
            .find('.key-change__keyfile-name')
            .text(this.keyFileName ? ': ' + this.keyFileName : '');
        this.inputEl = this.$el.find('.key-change__pass');
        this.passwordInput.reset();
        this.passwordInput.setElement(this.inputEl);
        this.inputEl.focus();
        if (repeat) {
            this.passwordRepeatInput = new SecureInput();
            this.passwordRepeatInput.reset();
            this.passwordRepeatInput.setElement(
                this.$el.find('.key-change__pass-repeat')
            );
        }
        return this;
    }

    inputKeydown(e: KeyboardEvent): void {
        if ((e as unknown as { which: number }).which === Keys.DOM_VK_RETURN) {
            this.accept();
        }
    }

    keyFileClicked(): void {
        if (this.keyFileName) {
            this.keyFileName = null;
            this.keyFile = null;
            this.$el.find('.key-change__keyfile-name').empty();
        }
        this.$el.find('.key-change__file').val(null).click();
        this.inputEl.focus();
    }

    keyFileSelected(e: Event): void {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                this.keyFileName = file.name;
                this.keyFileData = ev.target?.result as ArrayBuffer;
                this.$el
                    .find('.key-change__keyfile-name')
                    .text(': ' + this.keyFileName);
            };
            reader.onerror = () => {
                Alerts.error({ header: loc.openFailedRead ?? '' });
            };
            reader.readAsArrayBuffer(file);
        } else {
            this.$el.find('.key-change__keyfile-name').empty();
        }
        this.inputEl.focus();
    }

    accept(): void {
        if (!this.passwordInput.value.byteLength) {
            this.passwordInput.el.focus();
            this.passwordRepeatInput?.el.addClass('input--error');
            InputFx.shake(this.passwordInput.el);
            return;
        } else {
            this.passwordInput.el.removeClass('input--error');
        }
        if (this.passwordRepeatInput) {
            if (!this.passwordRepeatInput.value.equals(this.passwordInput.value)) {
                this.passwordRepeatInput.el.addClass('input--error');
                this.passwordRepeatInput.el.focus();
                InputFx.shake(this.passwordRepeatInput.el);
                return;
            }
        }
        this.emit('accept', {
            file: this.model.file,
            expired: this.model.expired,
            password: this.passwordInput.value,
            keyFileName: this.keyFileName,
            keyFileData: this.keyFileData
        });
    }

    cancel(): void {
        this.emit('cancel');
    }
}

export { KeyChangeView };
