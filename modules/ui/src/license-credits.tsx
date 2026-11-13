import license from '!!raw-loader!../../../LICENSE';
import notices from '!!raw-loader!../../../THIRD-PARTY-LICENSES.md';
import { t } from './i18n';

/** Source notices are rendered as escaped text and stay readable without a network connection. */
export function LicenseCredits() {
    const textStyle = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' } as const;
    return <>
        <details class="preference-help"><summary>{t('License text')}</summary>
            <pre style={textStyle} aria-label={t('License text')}>{license}</pre>
        </details>
        <details class="preference-help"><summary>{t('Credits and dependency notices')}</summary>
            <p>{t('KeeWebX is based on KeeWeb by Antelle. The notices below identify dependencies used by each interface and the browser extension.')}</p>
            <pre style={textStyle} aria-label={t('Credits and dependency notices')}>{notices}</pre>
        </details>
    </>;
}
