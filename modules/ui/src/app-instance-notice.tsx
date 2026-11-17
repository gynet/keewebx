import { t } from './i18n';
import './app-instance-notice.css';

export interface AppInstanceNoticeProps {
    state: 'checking' | 'secondary' | 'error';
    returning?: boolean;
    message?: string;
    onReturn: () => void;
    onRetry: () => void;
}

export function AppInstanceNotice({ state, returning = false, message, onReturn, onRetry }: AppInstanceNoticeProps) {
    const checking = state === 'checking';
    const secondary = state === 'secondary';

    return <main class="start__main app-instance-notice"
        aria-labelledby={checking ? undefined : 'app-instance-notice-title'}>
        <section class="card app-instance-notice__card">
            {checking ? <p class="app-instance-notice__status" role="status">{t('Opening KeeWebX…')}</p> : <>
                <h1 id="app-instance-notice-title" class="app-instance-notice__title">
                    {t(secondary ? 'KeeWebX is already open' : 'Unable to check open tabs')}
                </h1>
                <p class="app-instance-notice__body">
                    {t(secondary ? 'Return to your original tab to keep using your unlocked vault.'
                        : 'Please try again so KeeWebX can check that it is safe to access your vault in this tab.')}
                </p>
                <button type="button" class="pill pill--primary app-instance-notice__action"
                    disabled={secondary && returning} aria-busy={secondary && returning}
                    onClick={secondary ? onReturn : onRetry}>
                    {t(secondary ? 'Return to KeeWebX' : 'Try again')}
                </button>
                {message && <p class="app-instance-notice__status" role="status">{t(message)}</p>}
            </>}
        </section>
    </main>;
}
