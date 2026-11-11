const SemVer = {
    compareVersions(left: string, right: string): number {
        const leftParts = left.replace(/-.*$/, '').split('.');
        const rightParts = right.replace(/-.*$/, '').split('.');
        for (let num = 0; num < leftParts.length; num++) {
            const partLeft = +leftParts[num] | 0;
            const partRight = +rightParts[num] | 0;
            if (partLeft < partRight) {
                return -1;
            }
            if (partLeft > partRight) {
                return 1;
            }
        }
        return 0;
    }
};

export { SemVer };
