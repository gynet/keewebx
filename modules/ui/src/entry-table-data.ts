export const tableColumns = [
    ['title', 'Title'], ['user', 'Username'], ['website', 'Website'], ['tags', 'Tags'],
    ['notes', 'Notes'], ['group', 'Group'], ['file', 'Database']
] as const;
export type TableColumn = typeof tableColumns[number][0];
export function visibleColumns(value: unknown): TableColumn[] {
    if (!Array.isArray(value) || !value.length) return ['title', 'user', 'website'];
    return tableColumns.map(([key]) => key).filter(key => key === 'title' || value.includes(key));
}
export const ENTRY_PAGE_SIZE = 200;
export function entryPage(page: number, count: number): number {
    return Math.max(0, Math.min(Number.isFinite(page) ? Math.floor(page) : 0, Math.ceil(count / ENTRY_PAGE_SIZE) - 1));
}
