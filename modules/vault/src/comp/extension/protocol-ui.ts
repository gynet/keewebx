import type { EntryModel } from 'models/entry-model';
import type { SelectEntryFilter } from 'comp/app/select-entry-filter';

export interface ConnectPrompt {
    extensionName: string;
    identityVerified: boolean;
    files: Array<{ id: string; name: string; checked: boolean }>;
    allFiles: boolean;
    askGet: string;
    offerList: boolean;
    canList: boolean;
}

export interface ConnectDecision {
    files: string[];
    allFiles: boolean;
    askGet: string;
    canList?: boolean;
}

export interface SaveGroupChoice {
    id: string;
    fileId: string;
    fileName: string;
    path: string[];
    spaces: string[];
    title: string;
    selected: boolean;
}

export interface SavePrompt {
    extensionName: string;
    url: string;
    user?: string;
    askSave: string;
    update: boolean;
    allGroups: SaveGroupChoice[];
}

export interface SaveDecision {
    fileId: string;
    groupId: string;
    askSave: string;
}

export interface CreateGroupPrompt {
    extensionName: string;
    groupPath: string;
    files: Array<{ id: string; name: string; selected: boolean }>;
}

/** Trusted local UI decisions; null means cancel, never implicit approval. */
export interface ProtocolUi {
    isBusy(): boolean;
    connect(input: ConnectPrompt, signal: AbortSignal): Promise<ConnectDecision | null>;
    selectEntry(input: { filter: SelectEntryFilter; topMessage: string },
        signal: AbortSignal): Promise<EntryModel | null>;
    selectField(input: { entry: EntryModel }, signal: AbortSignal): Promise<string | null>;
    saveEntry(input: SavePrompt, signal: AbortSignal): Promise<SaveDecision | null>;
    createGroup(input: CreateGroupPrompt, signal: AbortSignal): Promise<string | null>;
    showTouch(input: { deviceShortName: string }, onCancel: () => void,
        signal: AbortSignal): { dispose(): void };
}
