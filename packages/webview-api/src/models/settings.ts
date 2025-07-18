import type { TextDocument, Workspace, WorkspaceFolder } from './workspace.js';

export interface Settings {
    dictionaries: DictionaryEntry[];
    configs: Configs;
    knownLanguageIds: string[];
    workspace?: Workspace;
    activeFileUri?: string;
    activeFolderUri?: string;
}

export type LocaleId = string;
export type LocaleList = LocaleId[];

export type FileType = string;
export type FileTypeList = FileType[];

export type FileUri = string;

export type ConfigTarget = keyof SettingByConfigTarget<void>;
export type ConfigSource = ConfigTarget | 'default';

export type Extends<T> = T;

export interface SettingByConfigTarget<T> {
    user: T;
    workspace: T;
    folder: T;
}

export interface Configs extends SettingByConfigTarget<Config> {
    file: FileConfig | undefined;
}

export interface DictionaryEntry {
    name: string;
    locales: LocaleList;
    languageIds: FileTypeList;
    description?: string;
    uri?: FileUri;
    uriName?: string;
}

export interface Config {
    inherited: { [key in keyof Config]?: ConfigSource };
    locales: Extends<LocaleList>;
    languageIdsEnabled: Extends<FileTypeList>;
}

export interface FileConfig extends TextDocument, IsSpellCheckEnabledResult {
    dictionaries: DictionaryEntry[];
    configFiles: ConfigFile[];
    workspaceFolder?: WorkspaceFolder | undefined;
    /** Uri used to calculate the settings. Might be different from the document uri. */
    uriActual?: FileUri;
    locales: Extends<LocaleList>;
}

export interface ExcludeRef {
    glob: string;
    id?: string | undefined;
    name?: string | undefined;
    configUri?: string | undefined;
}

export interface GitignoreInfo {
    gitignoreFileUri: string;
    gitignoreName: string;
    glob: string | undefined;
    line: number | undefined;
    matched: boolean;
    root: string | undefined;
}

export interface BlockedFileReason {
    code: string;
    message: string;
    documentationRefUri: string;
    settingsUri: string;
}

export interface IsSpellCheckEnabledResult {
    /** Is the spell checker enabled for file? */
    enabled?: boolean | undefined;
    /** cSpell.enabled setting */
    enabledVSCode?: boolean | undefined;
    languageIdEnabled?: boolean | undefined;
    fileEnabled: boolean;
    fileIsIncluded: boolean;
    fileIsExcluded: boolean;
    fileIsInWorkspace: boolean;
    excludedBy?: ExcludeRef[] | undefined;
    gitignoreInfo: GitignoreInfo | undefined;
    blockedReason: BlockedFileReason | undefined;
}

export interface ConfigFile {
    uri: FileUri;
    name: string;
}
