type PickerPlatform = Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>;

export function databaseFileAccept({ userAgent, platform, maxTouchPoints }: PickerPlatform): string | undefined {
    const ios = /iPhone|iPad|iPod/.test(userAgent)
        || (/Mac/.test(platform) && maxTouchPoints > 1);
    // iOS may not know the KDBX UTI and disable files under an extension filter.
    // iPadOS can identify as a Mac; its multi-touch support distinguishes it.
    return ios ? undefined : '.kdbx,.kdb';
}
