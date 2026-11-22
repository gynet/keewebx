import { Events } from 'framework/events';
import { AppSettingsModel } from 'models/app-settings-model';

const IdleTracker = {
    actionTime: Date.now(),
    init(): void {
        const check = () => this.checkIdle();
        setInterval(check, 1000 * 60);
        window.addEventListener('focus', check);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') check();
        });
    },
    checkIdle(): void {
        const idleMinutes = (Date.now() - this.actionTime) / 1000 / 60;
        const maxIdleMinutes = AppSettingsModel.idleMinutes;
        if (maxIdleMinutes && idleMinutes > maxIdleMinutes) {
            Events.emit('before-user-idle');
            Events.emit('user-idle');
        }
    },
    regUserAction(): void {
        this.actionTime = Date.now();
    }
};

Events.on('power-monitor-resume', () => IdleTracker.checkIdle());

export { IdleTracker };
