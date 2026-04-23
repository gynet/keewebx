interface RuntimeInfoType {
    readonly version: string;
    readonly beta: boolean;
    readonly buildDate: string;
    readonly commit: string;
    readonly devMode: string;
    readonly appleTeamId: string;
}

const RuntimeInfo: RuntimeInfoType = {
    version: '@@VERSION',
    // @@BETA is replaced at build time by webpack string-replace-loader
    beta: Boolean('@@BETA'),
    buildDate: '@@DATE',
    commit: '@@COMMIT',
    devMode: '@@DEVMODE',
    appleTeamId: '@@APPLE_TEAM_ID'
};

export { RuntimeInfo };
export type { RuntimeInfoType };
