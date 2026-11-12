import { Logger } from 'util/logger';

const logger = new Logger(
    'focus-manager',
    undefined,
    localStorage.debugFocusManager ? Logger.Level.Debug : Logger.Level.Info
);

const FocusManager = {
    modal: null as unknown,

    setModal(modal: unknown): void {
        this.modal = modal;
        logger.debug('Set modal', modal);
    }
};

export { FocusManager };
