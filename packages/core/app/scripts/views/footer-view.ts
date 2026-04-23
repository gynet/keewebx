import { View } from 'framework/views/view';
import { Events } from 'framework/events';
import { KeyHandler } from 'comp/browser/key-handler';
import { Keys } from 'const/keys';
import { UpdateModel } from 'models/update-model';
import { AppModel } from 'models/app-model';
import { GeneratorView } from 'views/generator-view';
import template from 'templates/footer.hbs';

class FooterView extends View {
    parent = '.app__footer';

    template = template;

    declare model: AppModel;

    events: Record<string, string> = {
        'click .footer__db-item': 'showFile',
        'click .footer__db-open': 'openFile',
        'click .footer__btn-help': 'toggleHelp',
        'click .footer__btn-settings': 'toggleSettings',
        'click .footer__btn-generate': 'genPass',
        'click .footer__btn-lock': 'lockWorkspace'
    };

    constructor(model: AppModel, options?: Record<string, unknown>) {
        super(model, options);

        this.onKey(Keys.DOM_VK_L, this.lockWorkspace, KeyHandler.SHORTCUT_ACTION, undefined, true);
        this.onKey(Keys.DOM_VK_G, this.genPass, KeyHandler.SHORTCUT_ACTION);
        this.onKey(Keys.DOM_VK_O, this.openFile, KeyHandler.SHORTCUT_ACTION);
        this.onKey(Keys.DOM_VK_S, this.saveAll, KeyHandler.SHORTCUT_ACTION);
        this.onKey(Keys.DOM_VK_COMMA, this.toggleSettings, KeyHandler.SHORTCUT_ACTION);

        this.listenTo(this, 'hide', this.viewHidden);
        this.listenTo(this.model.files, 'change', this.render);
        this.listenTo(Events, 'file-changed', this.render);
        this.listenTo(Events, 'set-locale', this.render);
        this.listenTo(UpdateModel, 'change:updateStatus', this.render);
    }

    render(): this | undefined {
        super.render({
            files: this.model.files,
            updateAvailable:
                ['ready', 'found'].indexOf(UpdateModel.updateStatus ?? '') >= 0
        });
        return this;
    }

    viewHidden(): void {
        if (this.views.gen) {
            (this.views.gen as View).remove();
            delete this.views.gen;
        }
    }

    lockWorkspace(e: Event): void {
        if (this.model.files.hasOpenFiles()) {
            e.preventDefault();
            Events.emit('lock-workspace');
        }
    }

    genPass(e: Event): void {
        e.stopPropagation();
        if (this.views.gen) {
            (this.views.gen as View).remove();
            return;
        }
        const el = this.$el.find('.footer__btn-generate');
        const rect = el[0].getBoundingClientRect();
        const bodyRect = document.body.getBoundingClientRect();
        const right = bodyRect.right - rect.right;
        const bottom = bodyRect.bottom - rect.top;
        const generator = new GeneratorView({ copy: true, pos: { right, bottom } });
        generator.render();
        generator.once('remove', () => {
            delete this.views.gen;
        });
        this.views.gen = generator as unknown as View;
    }

    showFile(e: Event): void {
        const fileId = $(e.target as Element).closest('.footer__db-item').data('file-id');
        if (fileId) {
            Events.emit('show-file', { fileId });
        }
    }

    openFile(): void {
        Events.emit('open-file');
    }

    saveAll(): void {
        Events.emit('save-all');
    }

    toggleHelp(): void {
        Events.emit('toggle-settings', 'help');
    }

    toggleSettings(): void {
        Events.emit('toggle-settings', 'general');
    }
}

export { FooterView };
