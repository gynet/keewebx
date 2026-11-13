import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { Events } from 'framework/events';

export interface StorageUiExtension {
    id: string;
    provider: string;
    title: string;
    Settings?: ComponentType<{ model: AppModel }>;
    DatabaseSettings?: ComponentType<{ model: AppModel; file: FileModel }>;
}
const extensions = new Map<string, StorageUiExtension>();
const listeners = new Set<() => void>();
/** UI extensions are trusted build modules; the public build registers none. */
export function registerStorageUi(extension: StorageUiExtension): () => void {
    if (!extension.id || !extension.provider || extensions.has(extension.id)) throw new Error('Invalid or duplicate storage UI registration');
    extensions.set(extension.id, extension);
    listeners.forEach(listener => listener());
    return () => { if (extensions.get(extension.id) === extension) { extensions.delete(extension.id); listeners.forEach(listener => listener()); } };
}
export function useStorageExtensions(): readonly StorageUiExtension[] {
    const [, refresh] = useState(0);
    useEffect(() => {
        const changed = () => refresh(value => value + 1);
        listeners.add(changed); Events.on('refresh', changed);
        return () => { listeners.delete(changed); Events.off('refresh', changed); };
    }, []);
    return [...extensions.values()];
}
export function RegisteredStorageSettings({ model, file }: { model: AppModel; file?: FileModel }) {
    return <>{useStorageExtensions().map(extension => {
        const Component = file ? extension.DatabaseSettings : extension.Settings;
        return Component ? <Component key={extension.id} model={model} file={file!} /> : null;
    })}</>;
}
