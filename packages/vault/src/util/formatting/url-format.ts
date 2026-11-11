const UrlFormat = {
    multiSlashRegex: /\/{2,}/g,
    lastPartRegex: /[\/\\]?[^\/\\]+$/,
    kdbxEndRegex: /\.kdbx$/i,
    maxShortPresentableUrlLength: 60,

    getDataFileName(url: string): string {
        const ix = url.lastIndexOf('/');
        if (ix >= 0) {
            url = url.substr(ix + 1);
        }
        url = url.replace(/\?.*/, '').replace(/\.kdbx/i, '');
        return url;
    },

    isKdbx(url: string): boolean {
        return !!url && this.kdbxEndRegex.test(url);
    },

    fixSlashes(url: string): string {
        return url.replace(this.multiSlashRegex, '/');
    },

    fileToDir(url: string): string {
        return url.replace(this.lastPartRegex, '') || '/';
    },

    makeUrl(base: string, args: Record<string, string>): string {
        const queryString = Object.entries(args)
            .map(([key, value]) => key + '=' + encodeURIComponent(value))
            .join('&');
        return base + '?' + queryString;
    },

    buildFormData(params: Record<string, string>): string {
        return Object.entries(params)
            .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
            .join('&');
    },

    presentAsShortUrl(url: string): string {
        if (url.length <= this.maxShortPresentableUrlLength) {
            return url;
        }

        const [beforeHash] = url.split('#', 1);
        if (beforeHash.length <= this.maxShortPresentableUrlLength) {
            return beforeHash + '#\u2026';
        }

        const [beforeQuestionMark] = url.split('?', 1);
        if (beforeQuestionMark.length <= this.maxShortPresentableUrlLength) {
            return beforeQuestionMark + '?\u2026';
        }

        const parsed = new URL(beforeQuestionMark);
        const pathParts = parsed.pathname.split('/');

        while (pathParts.length > 1) {
            pathParts.pop();
            parsed.pathname = pathParts.join('/');
            const res = parsed.toString();
            if (res.length < this.maxShortPresentableUrlLength) {
                return res + '/\u2026';
            }
        }

        return parsed.toString() + '\u2026';
    }
};

export { UrlFormat };
