import { Events } from 'framework/events';
import { AppSettingsModel } from 'models/app-settings-model';

const IdleTracker = {
    actionTime: Date.now(),
    init(): void {
        setInterval(this.checkIdle.bind(this), 1000 * 60);
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

Events.on('power-monitor-resume', () => IdleTracker.checkIdle);

export { IdleTracker };
