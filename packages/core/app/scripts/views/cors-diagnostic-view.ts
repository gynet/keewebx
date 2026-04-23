import { View } from 'framework/views/view';
import { Keys } from 'const/keys';
import { CopyPaste } from 'comp/browser/copy-paste';
import { FocusManager } from 'comp/app/focus-manager';
import template from 'templates/cors-diagnostic.hbs';

interface CorsDiagnosticModel {
    serverUrl: string;
    origin: string;
}

/**
 * Modal view that displays CORS diagnostic information when a WebDAV
 * connection fails due to missing CORS headers. Shows tabbed config
 * snippets for Nextcloud, Apache, nginx, and Synology with copy-to-clipboard
 * support and a "Test again" button.
 */
class CorsDiagnosticView extends View {
    parent = 'body';
    modal = 'cors-diagnostic';

    template = template;

    override model: CorsDiagnosticModel;

    events: Record<string, string> = {
        'click .cors-diag__tab': 'tabClick',
        'click .cors-diag__copy-btn': 'copyClick',
        'click .cors-diag__test-btn': 'testClick',
        'click [data-result="close"]': 'closeClick',
        'click': 'bodyClick'
    };

    constructor(model: CorsDiagnosticModel) {
        super(model);
        this.model = model;
        this.onKey(Keys.DOM_VK_ESCAPE, this.closeClick.bind(this), undefined, 'cors-diagnostic');
    }

    render(): this | undefined {
        super.render(this.model);
        this.$el.addClass('modal--hidden');
        setTimeout(() => {
            this.$el.removeClass('modal--hidden');
            (document.activeElement as HTMLElement | null)?.blur();
        }, 20);
        return this;
    }

    tabClick(e: Event): void {
        const target = e.target as HTMLElement;
        const btn = target.closest('.cors-diag__tab') as HTMLElement | null;
        if (!btn) {
            return;
        }
        const tabId = btn.dataset.tab;
        if (!tabId) {
            return;
        }

        // Update active tab button
        const tabs = this.el.querySelectorAll('.cors-diag__tab');
        for (const tab of tabs) {
            tab.classList.toggle('cors-diag__tab--active', tab === btn);
        }

        // Update active panel
        const panels = this.el.querySelectorAll('.cors-diag__panel');
        for (const panel of panels) {
            const panelEl = panel as HTMLElement;
            panelEl.classList.toggle(
                'cors-diag__panel--active',
                panelEl.dataset.panel === tabId
            );
        }
    }

    copyClick(e: Event): void {
        const target = e.target as HTMLElement;
        const btn = target.closest('.cors-diag__copy-btn') as HTMLElement | null;
        if (!btn) {
            return;
        }
        const panelId = btn.dataset.copyPanel;
        if (!panelId) {
            return;
        }
        const codeEl = this.el.querySelector(
            `.cors-diag__code[data-panel-code="${panelId}"]`
        );
        if (!codeEl) {
            return;
        }
        const text = codeEl.textContent ?? '';
        const result = CopyPaste.copy(text);
        if (result && result.success) {
            const icon = btn.querySelector('i');
            if (icon) {
                icon.className = 'fa fa-check';
                setTimeout(() => {
                    icon.className = 'fa fa-copy';
                }, 1500);
            }
        }
    }

    testClick(): void {
        this.emit('test-again');
    }

    closeClick(): void {
        this.closeModal();
    }

    bodyClick(e: Event): void {
        const target = e.target as Element;
        if (target.classList.contains('cors-diag') || target.classList.contains('modal__content')) {
            // Click on backdrop area - don't close; force user to click buttons
        }
    }

    closeModal(): void {
        this.$el.addClass('modal--hidden');
        this.unbindEvents();
        setTimeout(() => {
            if (this.modal && FocusManager.modal === this.modal) {
                FocusManager.setModal(null);
            }
            this.remove();
        }, 100);
        this.emit('closed');
    }
}

export { CorsDiagnosticView };
export type { CorsDiagnosticModel };
