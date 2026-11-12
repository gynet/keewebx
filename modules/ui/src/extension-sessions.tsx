import { useLayoutEffect, useMemo, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import { ProtocolImpl, type ClientPermissions } from 'comp/extension/protocol-impl';
import { Events } from 'framework/events';
import { getSessionAccess } from 'comp/app/session-access';
import { Icon } from 'ui-kit/mark';
import { PromptDialog } from './extension-prompts';
import { t } from './i18n';

export type ExtensionSession = (typeof ProtocolImpl.sessions)[number];

export type ExtensionApprovals = typeof ProtocolImpl.approvals;

/** Current sessions and explicit remembered-approval revocation are separate operations. */
export interface ExtensionSessionsApi {
    getSnapshot(): readonly ExtensionSession[];
    subscribe(listener: () => void): () => void;
    setPermissions(clientId: string, permissions: Partial<ClientPermissions>): void;
    disconnect(connectionId: number): void;
    getApprovals(): ExtensionApprovals;
    forgetApproval(identity: string): void;
    forgetLegacyApproval(): void;
}

/** Does not initialize or enable the connector. */
export function createExtensionSessionsApi(model: AppModel): ExtensionSessionsApi {
    const access = getSessionAccess(model);
    return {
        getSnapshot: () => ProtocolImpl.sessions,
        getApprovals: () => ProtocolImpl.approvals,
        subscribe(listener) {
            Events.on('browser-extension-sessions-changed', listener);
            return () => Events.off('browser-extension-sessions-changed', listener);
        },
        setPermissions(id, permissions) { access.assertOpen(); ProtocolImpl.setClientPermissions(id, permissions); },
        disconnect(id) { access.assertOpen(); ProtocolImpl.deleteConnection(id); },
        forgetApproval(identity) { access.assertOpen(); ProtocolImpl.forgetApproval(identity); },
        forgetLegacyApproval() { access.assertOpen(); ProtocolImpl.forgetLegacyApproval(); }
    };
}

export function ExtensionSessions({ model, api: providedApi, onBack }: {
    model: AppModel; api?: ExtensionSessionsApi; onBack(): void;
}) {
    const api = useMemo(() => providedApi ?? createExtensionSessionsApi(model), [providedApi, model]);
    const [approvals, setApprovals] = useState(() => api.getApprovals());
    const [forgetting, setForgetting] = useState<{ identity?: string; epoch: number } | null>(null);
    const [sessions, setSessions] = useState<readonly ExtensionSession[]>(() => api?.getSnapshot() ?? []);
    const [disconnecting, setDisconnecting] = useState<{ session: ExtensionSession; epoch: number } | null>(null);
    const [error, setError] = useState('');
    const access = getSessionAccess(model);
    const refresh = () => { setSessions(api.getSnapshot()); setApprovals(api.getApprovals()); };
    useLayoutEffect(() => {
        refresh();
        return api?.subscribe(refresh);
    }, [api]);
    useLayoutEffect(() => access.subscribeInvalidation(() => { setDisconnecting(null); setForgetting(null); }), [access]);
    const update = (session: ExtensionSession, permissions: Partial<ClientPermissions>) => {
        try {
            access.assertOpen();
            if (!api?.getSnapshot().some((current) => current.clientId === session.clientId
                && current.generation === session.generation && current.connectionId === session.connectionId && current.connectedDate.getTime() === session.connectedDate.getTime())) throw new Error('stale');
            api.setPermissions(session.clientId, permissions);
            setError(''); refresh();
        } catch { setError(t('This session changed or access is suspended. Reopen extension settings to continue.')); }
    };
    return <section aria-label={t('Browser extension sessions')}>
        <button class="pill" type="button" onClick={onBack}><Icon name="back" size={16} /> {t('Back to settings')}</button>
        <h2>{t('Browser extension sessions')}</h2>
        {!providedApi && <p role="status">{t('Browser extension connections are not enabled in this interface yet.')}</p>}
        {!sessions.length ? <p role="status">{t('No browser extension sessions')}</p> : <>
                <p class="muted">{t('These controls change the current session. Disconnecting does not erase remembered approvals.')}</p>
                {sessions.map((session) => <section key={session.clientId} class="cardlist" style={{ padding: '16px', marginBottom: '16px', overflowWrap: 'anywhere' }}>
                    <h3 style={{ marginTop: 0 }}>{session.extensionName}{session.appName ? ` (${session.appName})` : ''}</h3>
                    <p class="muted">{t('Connected: {}', session.connectedDate.toLocaleString())}</p>
                    {!session.permissions ? <p>{t(session.permissionsDenied ? 'Access denied' : 'Awaiting approval')}</p> : <>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: '44px' }}>
                            <input type="checkbox" checked={!!session.permissions.allFiles} onChange={(event) => update(session, {
                                allFiles: event.currentTarget.checked, files: model.files.map((file) => file.id)
                            })} />{t('All databases, including ones opened later')}
                        </label>
                        {model.files.map((file, index) => <label key={file.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: '44px' }}>
                            <input type="checkbox" checked={!!session.permissions?.allFiles || !!session.permissions?.files?.includes(file.id)}
                                onChange={(event) => {
                                    const files = session.permissions?.allFiles ? model.files.map((item) => item.id) : session.permissions?.files ?? [];
                                    update(session, { allFiles: false, files: event.currentTarget.checked
                                        ? [...new Set([...files, file.id])] : files.filter((id) => id !== file.id) });
                                }} /><span>{t('{} ({})', file.name, String(index + 1))}</span>
                        </label>)}
                        <label class="vault-form__field">{t('Ask before reading a login')}
                            <select class="input" value={session.permissions.askGet ?? 'multiple'} onChange={(event) => update(session, { askGet: event.currentTarget.value })}>
                                <option value="multiple">{t('When more than one entry matches')}</option><option value="always">{t('Always')}</option>
                            </select>
                        </label>
                        {session.permissions.askSave !== undefined && <label class="vault-form__field">{t('Ask before saving a login')}
                            <select class="input" value={session.permissions.askSave} onChange={(event) => update(session, { askSave: event.currentTarget.value })}>
                                <option value="always">{t('Always')}</option><option value="auto">{t('Save automatically')}</option>
                            </select>
                        </label>}
                        {session.permissions.canList !== undefined && <label style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: '44px' }}>
                            <input type="checkbox" checked={!!session.permissions.canList} onChange={(event) => update(session, { canList: event.currentTarget.checked })} />
                            <span>{t('Allow listing and searching entries')}</span>
                        </label>}
                    </>}
                    <button type="button" class="pill pill--tinted pill--danger" onClick={() => { setError(''); setDisconnecting({ session, epoch: access.epoch }); }}>
                        <Icon name="close" size={16} />{t('Disconnect session')}
                    </button>
                </section>)}
            </>}
        <h3>{t('Remembered approvals')}</h3>
        {!approvals.identities.length && !approvals.legacy && <p>{t('No remembered approvals')}</p>}
        {approvals.identities.map((approval) => <div key={approval.identity} style={{ marginBottom: '16px', overflowWrap: 'anywhere' }}>
            <p>{t('Extension identity: {}', approval.identity)}</p>
            {approval.pendingPersistence && <p role="alert">{t('Forgetting this approval has not been saved. Retry before reloading.')}</p>}
            <button type="button" class="pill pill--tinted pill--danger" onClick={() => { setError(''); setForgetting({ identity: approval.identity, epoch: access.epoch }); }}>
                <Icon name="close" size={16} />{t('Forget approval')}
            </button>
        </div>)}
        {approvals.legacy && <div>
            <p>{t('Legacy shared approval is not tied to one extension identity.')}</p>
            {approvals.legacyPendingPersistence && <p role="alert">{t('Clearing the legacy approval has not been saved. Retry before reloading.')}</p>}
            <button type="button" class="pill pill--tinted pill--danger" onClick={() => { setError(''); setForgetting({ epoch: access.epoch }); }}>
                <Icon name="close" size={16} />{t('Forget legacy shared approval')}
            </button>
        </div>}
        {forgetting && <PromptDialog title={t(forgetting.identity ? 'Forget extension approval' : 'Forget legacy shared approval')}
            icon="globe" cancel={() => { setForgetting(null); setError(''); }} confirmLabel={t('Forget approval')} confirm={() => {
                try {
                    access.assertOpen(forgetting.epoch);
                    if (forgetting.identity) api.forgetApproval(forgetting.identity);
                    else api.forgetLegacyApproval();
                    setError(''); setForgetting(null); refresh();
                } catch { setError(t('The approval could not be saved as forgotten. Access is denied for this session; retry before reloading.')); }
            }}>
            {forgetting.identity ? <>
                <p style={{ overflowWrap: 'anywhere' }}>{t('Extension identity: {}', forgetting.identity)}</p>
                <p>{t('Forget this identity’s remembered approval and disconnect its current session? It must request approval again, even if a legacy shared approval exists.')}</p>
            </> : <p>{t('Clear the shared approval for all legacy clients and paired identities using it? Their current sessions will disconnect. Separate identity approvals remain.')}</p>}
            {error && <p class="error" role="alert">{error}</p>}
        </PromptDialog>}
        {!forgetting && error && <p class="error" role="alert">{error}</p>}
        {disconnecting && <PromptDialog title={t('Disconnect extension session')} icon="globe" cancel={() => setDisconnecting(null)}
            confirmLabel={t('Disconnect')} confirm={() => {
                try {
                    access.assertOpen(disconnecting.epoch);
                    if (!api?.getSnapshot().some((session) => session.clientId === disconnecting.session.clientId
                        && session.generation === disconnecting.session.generation && session.connectionId === disconnecting.session.connectionId && session.connectedDate.getTime() === disconnecting.session.connectedDate.getTime())) throw new Error('stale');
                    api.disconnect(disconnecting.session.connectionId); refresh();
                } catch { setError(t('This session changed or access is suspended. Reopen extension settings to continue.')); }
                finally { setDisconnecting(null); }
            }}>
            <p>{t('Disconnect {}?', disconnecting.session.extensionName)}</p>
            <p>{t('This ends the current connection. Remembered approvals may allow the extension to reconnect.')}</p>
        </PromptDialog>}
    </section>;
}
