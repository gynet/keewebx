import { Events } from 'framework/events';
import { Features } from 'util/features';

const FocusDetector = {
    isFocused: true,

    init(): void {
        this.isFocused = true;
        if (!Features.isMobile) {
            window.addEventListener('focus', () => {
                if (!FocusDetector.isFocused) {
                    FocusDetector.isFocused = true;
                    Events.emit('main-window-focus');
                }
            });
            window.addEventListener('blur', () => {
                if (FocusDetector.isFocused) {
                    FocusDetector.isFocused = false;
                    Events.emit('main-window-blur');
                }
            });
        }
    },

    hasFocus(): boolean {
        return this.isFocused;
    }
};

export { FocusDetector };
