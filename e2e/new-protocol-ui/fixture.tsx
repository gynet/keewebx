import 'ui-kit/tokens.css';
import '../../modules/ui/src/styles.css';
import { render } from 'preact';
import { Model } from 'framework/model';
import type { AppModel } from 'models/app-model';
import type { EntryModel } from 'models/entry-model';
import { ProtectedValue, Credentials, Kdbx } from 'kdbxweb';
import { SelectEntryFilter } from 'comp/app/select-entry-filter';
import { getSessionAccess } from 'comp/app/session-access';
import { createNewProtocolUi } from '../../modules/ui/src/extension-ui';
import { NewProtocolUiHost } from '../../modules/ui/src/extension-prompts';
import { ExtensionSessions, type ExtensionSession, type ExtensionSessionsApi } from '../../modules/ui/src/extension-sessions';
import { setTranslations } from '../../modules/ui/src/i18n';

class TestEntry extends Model {}
TestEntry.defineModelProperties({}, { extensions: true });
const files = ['one', 'two'].map((id) => ({ id, name: 'Database', active: true,
    db: Kdbx.create(new Credentials(ProtectedValue.fromString('Fixture password')), 'Database') }));
const password = ProtectedValue.fromString('FixtureSecretNeverRender');
let secretReads = 0;
password.getText = () => { secretReads++; return 'FixtureSecretNeverRender'; };
const entries = ['Alpha', 'Beta'].map((title) => Object.assign(new TestEntry(), {
    id: title, title, file: files[0], groupName: 'Logins', user: 'user@example.com',
    icon: 'key', customIcon: null, searchText: title.toLowerCase(),
    getAllUrls: () => ['https://example.com'],
    getAllFields: () => ({ UserName: 'user@example.com', Password: password })
}) as unknown as EntryModel);
const model = {
    files: Object.assign(files, { hasOpenFiles: () => true }),
    getEntriesByFilter: ({ text }: { text: string }) => entries.filter((entry) => entry.title.toLowerCase().includes(text.toLowerCase()))
} as unknown as AppModel;
const ui = createNewProtocolUi(model, () => !!document.querySelector('dialog[open]'));
let signal = new AbortController();
let result: unknown;
let cancelCount = 0;
let failForget = false;
let touch: { dispose(): void } | undefined;
const api = {
    async show(kind: string) {
        signal = new AbortController(); result = undefined;
        const common = { extensionName: 'Fixture extension' };
        switch (kind) {
            case 'connect': result = await ui.connect({ ...common, identityVerified: true,
                files: files.map((file) => ({ ...file, checked: true })), allFiles: true,
                askGet: 'multiple', offerList: true, canList: true }, signal.signal); break;
            case 'entry': result = (await ui.selectEntry({
                filter: new SelectEntryFilter({ url: 'https://example.com', title: 'Page' },
                    model as unknown as ConstructorParameters<typeof SelectEntryFilter>[1], files, {}),
                topMessage: 'Fixture extension requests an entry'
            }, signal.signal))?.id ?? null; break;
            case 'field': result = await ui.selectField({ entry: entries[0] }, signal.signal); break;
            case 'save': result = await ui.saveEntry({ ...common, url: 'https://example.com/' + 'long-path/'.repeat(20),
                user: 'user@example.com', askSave: 'always', update: false,
                allGroups: files.flatMap((file, index) => [
                    { id: 'root', fileId: file.id, fileName: file.name, path: [file.name], title: file.name, spaces: [], selected: index === 0 },
                    { id: 'logins', fileId: file.id, fileName: file.name, path: [file.name, 'Logins'], title: 'Logins', spaces: [' ', ' '], selected: false }
                ]) }, signal.signal); break;
            case 'duplicate-save': result = await ui.saveEntry({ ...common, url: 'https://example.com',
                askSave: 'always', update: false, allGroups: ['Personal', 'Work'].map((parent) => ({
                    id: parent.toLowerCase(), fileId: 'one', fileName: 'Database', path: ['Database', parent, 'Logins'],
                    title: 'Logins', spaces: [' ', ' ', ' ', ' '], selected: false
                })) }, signal.signal); break;
            case 'group': result = await ui.createGroup({ ...common, groupPath: 'Browser / New group',
                files: files.map((file, index) => ({ ...file, selected: index === 0 })) }, signal.signal); break;
            case 'touch': touch = ui.showTouch({ deviceShortName: 'Fixture key' }, () => cancelCount++, signal.signal); break;
        }
    },
    failForget: (fail: boolean) => { failForget = fail; },
    abort: () => signal.abort(),
    dispose: () => touch?.dispose(),
    gate: () => { getSessionAccess(model).beginSecuring(); },
    get result() { return result; },
    get cancelCount() { return cancelCount; },
    get secretReads() { return secretReads; },
    translate: setTranslations
};
Object.assign(window, { extensionUiFixture: api });
let sessions: ExtensionSession[] = [{
    identity: 'fixture-identity', generation: 1, clientId: 'client', connectionId: 1, extensionName: 'Fixture extension', appName: undefined,
    connectedDate: new Date('2026-01-01'), passwordsRead: 0, passwordsWritten: 0, permissionsDenied: false,
    permissions: { allFiles: true, files: ['one', 'two'], askGet: 'multiple', askSave: 'always', canList: true }
}];
const listeners = new Set<() => void>();
let approvals: ReturnType<ExtensionSessionsApi['getApprovals']> = { identities: [{ identity: 'fixture-identity', created: '2026-01-01', permissions: {}, pendingPersistence: false }], legacy: {}, legacyPendingPersistence: false };
const sessionApi: ExtensionSessionsApi = {
    getApprovals: () => approvals,
    forgetApproval(identity) {
        approvals = { ...approvals, identities: failForget ? approvals.identities.map((item) => ({ ...item, pendingPersistence: item.identity === identity }))
            : approvals.identities.filter((item) => item.identity !== identity) };
        sessions = []; listeners.forEach((listener) => listener());
        if (failForget) throw new Error('Storage unavailable');
    },
    forgetLegacyApproval() { approvals = { ...approvals, legacy: undefined }; listeners.forEach((listener) => listener()); },
    getSnapshot: () => sessions,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setPermissions(id, permissions) {
        sessions = sessions.map((session) => session.clientId === id
            ? { ...session, permissions: { ...session.permissions, ...permissions } } : session);
        listeners.forEach((listener) => listener());
    },
    disconnect(id) { sessions = sessions.filter((session) => session.connectionId !== id); listeners.forEach((listener) => listener()); }
};
render(<main style={{ padding: '16px' }}>
    <h1>Extension UI fixture</h1>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        {['connect', 'entry', 'field', 'save', 'duplicate-save', 'group', 'touch'].map((kind) => <button class="pill" onClick={() => void api.show(kind)}>{kind}</button>)}
    </div>
    <NewProtocolUiHost controller={ui} />
    <ExtensionSessions model={model} api={sessionApi} onBack={() => {}} />
</main>, document.getElementById('root')!);
