/** A tag keeps its color across lists, reloads and devices without changing database data. */
export function tagColor(tag: string) {
    let hash = 0;
    for (let index = 0; index < tag.length; index++) {
        hash = tag.charCodeAt(index) + ((hash << 5) - hash);
    }
    return { '--tag-hue': String(Math.abs(hash) % 360) };
}
