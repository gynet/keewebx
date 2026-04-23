/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SettingsFileSectionExtension {
    id: string;
    init?(view: any): void;
    renderData?(model: any, appModel: any): Record<string, unknown> | null;
    renderHtml?(data: Record<string, unknown>): string;
    afterRender?(view: any): void;
}

const settingsFileSections: SettingsFileSectionExtension[] = [];

export function registerSettingsFileSection(ext: SettingsFileSectionExtension): void {
    settingsFileSections.push(ext);
}

export function getSettingsFileSections(): readonly SettingsFileSectionExtension[] {
    return settingsFileSections;
}
