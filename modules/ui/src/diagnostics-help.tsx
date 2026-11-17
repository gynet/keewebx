import { useState } from 'preact/hooks';
import { Logger } from 'util/logger';
import { Links } from 'const/links';
import { RuntimeInfo } from 'const/runtime-info';
import { diagnosticsText, safeLogs } from './diagnostics-data';
import { t } from './i18n';
import { ShortcutReference } from './shortcut-reference';
import './diagnostics-help.css';

export function DiagnosticsHelp() {
    const [logs, setLogs] = useState<ReturnType<typeof safeLogs> | null>(null);
    const [status, setStatus] = useState('');
    const diagnostics = diagnosticsText(RuntimeInfo, navigator.userAgent);
    const issue = `${Links.Repo}/issues/new?body=${encodeURIComponent('Describe the problem and steps to reproduce:\n\n\nDiagnostics:\n' + diagnostics)}`;
    return <section class="diagnostics-help app-preferences" aria-label={t('Help and diagnostics')}>
        <h2 class="group-title">{t('Help and diagnostics')}</h2>
        <ShortcutReference />
        <details class="preference-help"><summary>{t('Troubleshooting and issue reports')}</summary>
            <p>{t('If saving fails, keep the tab open, retry Save now, or download an encrypted KDBX backup from Database settings. Do not clear browser storage until you have verified a backup.')}</p>
            <p>{t('Review these diagnostics before copying them or opening an issue. They include your browser version, but no vault names, entry values, URLs, or credentials.')}</p>
            <pre tabIndex={0} aria-label={t('Diagnostics')}>{diagnostics}</pre>
            <div class="diagnostics-help__actions"><button type="button" class="pill" onClick={async () => {
                try { await navigator.clipboard.writeText(diagnostics); setStatus(t('Diagnostics copied')); }
                catch { setStatus(t('Could not copy. Select the diagnostics text and copy it manually.')); }
            }}>{t('Copy diagnostics')}</button>
                <a href={issue} target="_blank" rel="noopener noreferrer">{t('Open an issue draft')}</a></div>
            {status && <p role="status">{status}</p>}
        </details>
        <details class="preference-help"><summary>{t('Web app updates')}</summary>
            <p>{t('KeeWebX checks for updates before unlocking. Updates found during a session are applied the next time you open the app.')}</p>
            <p>{t('If no update appears, close other KeeWebX tabs and reopen the app. Keep a verified encrypted backup before clearing browser data.')}</p>
        </details>
        <details class="preference-help"><summary>{t('Application logs')}</summary>
            <p>{t('Recent application activity is summarized below. Sensitive log text and arguments are omitted. Logs are never uploaded automatically.')}</p>
            <button type="button" class="pill" onClick={() => setLogs(safeLogs(Logger.getLast()))}>{t('Refresh logs')}</button>
            {logs && <><p role="status">{t('{} recent events', String(logs.length))}</p>
                <ol class="diagnostics-help__logs">{logs.map((log, index) => <li key={index} data-level={log.level}>
                    <strong>{t(log.level)}</strong> <time>{log.time}</time> <span>{log.source}</span><br />{t(log.message)}
                </li>)}</ol></>}
        </details>
    </section>;
}
