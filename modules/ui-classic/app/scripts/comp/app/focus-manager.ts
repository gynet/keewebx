import { Logger } from 'util/logger';
import { storageKey } from 'comp/settings/storage-namespace';

const logger = new Logger(
    'focus-manager',
    undefined,
    localStorage[storageKey('debugFocusManager')] ? Logger.Level.Debug : Logger.Level.Info
);

const FocusManager = {
    modal: null as unknown,

    setModal(modal: unknown): void {
        this.modal = modal;
        logger.debug('Set modal', modal);
    }
};

export { FocusManager };
