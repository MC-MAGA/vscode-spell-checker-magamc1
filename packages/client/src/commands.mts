import { format } from 'node:util';

import { logError } from '@internal/common-utils/log';
import type { Command, ConfigurationScope, Diagnostic, Disposable, TextEdit, TextEditor, TextEditorEdit } from 'vscode';
import { commands, NotebookRange, Position, Range, Selection, SnippetString, TextEditorRevealType, Uri, window } from 'vscode';

import {
    addWordToFolderDictionary,
    addWordToTarget,
    addWordToUserDictionary,
    addWordToWorkspaceDictionary,
    fnWTarget,
} from './addWords.mjs';
import { actionAutoFixSpellingIssues, handleApplyLsTextEdits, handleFixSpellingIssue } from './applyCorrections.mjs';
import type { ClientSideCommandHandlerApi } from './client/index.mjs';
import { actionSuggestSpellingCorrections } from './codeActions/actionSuggestSpellingCorrections.mjs';
import { extensionSettings } from './constants.js';
import * as di from './di.mjs';
import { getCSpellDiags } from './diags.mjs';
import { onCommandUseDiagsSelectionOrPrompt } from './promptUser.mjs';
import type { ConfigRepository } from './settings/configRepository.mjs';
import { createCSpellConfigRepository, createVSCodeConfigRepository } from './settings/configRepository.mjs';
import { configTargetToConfigRepo } from './settings/configRepositoryHelper.mjs';
import {
    createClientConfigTargetVSCode,
    dictionaryTargetBestMatches,
    dictionaryTargetBestMatchesCSpell,
    dictionaryTargetBestMatchesVSCodeFolder as dtVSCodeFolder,
    dictionaryTargetBestMatchesVSCodeUser as dtVSCodeUser,
    dictionaryTargetBestMatchesVSCodeWorkspace as dtVSCodeWorkspace,
    quickPickTarget,
} from './settings/configTargetHelper.mjs';
import type { DictionaryTarget } from './settings/DictionaryTarget.mjs';
import { createDictionaryTargetForFile } from './settings/DictionaryTarget.mjs';
import type { ConfigTargetLegacy } from './settings/index.mjs';
import {
    addIgnoreWordsToSettings,
    ConfigurationTarget,
    createConfigFileRelativeToDocumentUri,
    enableLocaleForTarget,
    normalizeTarget,
    setEnableSpellChecking,
    toggleEnableSpellChecker,
    updateEnabledFileTypeForResource,
    updateEnabledFileTypeForTarget,
} from './settings/index.mjs';
import { configurationTargetToDictionaryScope, dictionaryScopeToConfigurationTarget } from './settings/targetAndScope.mjs';
import {
    targetsAndScopeFromConfigurationTarget,
    targetsForTextDocument,
    targetsForUri,
    targetsFromConfigurationTarget,
} from './settings/targetHelpers.mjs';
import { setContext } from './storage/index.mjs';
import { about, rateTheSpellChecker, releaseNotes, reportIssue, sponsor, supportRequest } from './support/index.mjs';
import { experimentWithSymbols } from './symbolServer/index.mjs';
import { findNotebookCell } from './util/documentUri.js';
import { catchErrors, handleErrors } from './util/errors.js';
import { performance, toMilliseconds } from './util/perf.js';
import { pVoid } from './util/pVoid.js';
import { scrollToText } from './util/textEditor.js';
import { toUri } from './util/uriHelper.mjs';
import type { Position as LsPosition, Range as LsRange, TextEdit as LsTextEdit } from './vscode-languageclient/node.cjs';

const commandsFromServer: ClientSideCommandHandlerApi = {
    'cSpell.addWordsToConfigFileFromServer': (words, _documentUri, config) => {
        return addWordsToConfig(words, createCSpellConfigRepository(toUri(config.uri), config.name));
    },
    'cSpell.addWordsToDictionaryFileFromServer': (words, _documentUri, dict) => {
        return addWordsToDictionaryTarget(words, createDictionaryTargetForFile(toUri(dict.uri), dict.name));
    },
    'cSpell.addWordsToVSCodeSettingsFromServer': (words, documentUri, target) => {
        const cfgTarget = dictionaryScopeToConfigurationTarget(target);
        const cfgRepo = createVSCodeConfigRepository(cfgTarget, toUri(documentUri), false);
        return addWordsToConfig(words, cfgRepo);
    },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExplicitAny = any;

type CommandHandler =
    | ((...params: ExplicitAny[]) => void)
    | ((...params: ExplicitAny[]) => undefined)
    | ((...params: ExplicitAny[]) => Promise<unknown>);
type CommandHandlers = Record<string, CommandHandler>;

const prompt = onCommandUseDiagsSelectionOrPrompt;
const tsFCfg = (configTarget: ConfigurationTarget, limitToTarget = false) =>
    targetsAndScopeFromConfigurationTarget(configTarget, undefined, undefined, limitToTarget);
const actionAddWordToFolder = prompt('Add Words to Folder Dictionary', addWordToFolderDictionary);
const actionAddWordToWorkspace = prompt('Add Words to Workspace Dictionaries', addWordToWorkspaceDictionary);
const actionAddWordToUser = prompt('Add Words to User Dictionary', addWordToUserDictionary);
const actionAddWordToFolderSettings = prompt('Add Words to Folder Settings', fnWTarget(addWordToTarget, dtVSCodeFolder));
const actionAddWordToWorkspaceSettings = prompt('Add Words to Workspace Settings', fnWTarget(addWordToTarget, dtVSCodeWorkspace));
const actionAddWordToUserSettings = prompt('Add Words to User Settings', fnWTarget(addWordToTarget, dtVSCodeUser));
const actionRemoveWordFromFolderDictionary = prompt('Remove Words from Folder Dictionary', removeWordFromFolderDictionary);
const actionRemoveWordFromWorkspaceDictionary = prompt('Remove Words from Workspace Dictionaries', removeWordFromWorkspaceDictionary);
const actionRemoveWordFromUserDictionary = prompt('Remove Words from Global Dictionary', removeWordFromUserDictionary);
const actionAddIgnoreWord = prompt('Ignore Words', fnWTarget(addIgnoreWordsToTarget, undefined));
const actionAddIgnoreWordToFolder = prompt(
    'Ignore Words in Folder Settings',
    fnWTarget(addIgnoreWordsToTarget, ConfigurationTarget.WorkspaceFolder),
);
const actionAddIgnoreWordToWorkspace = prompt(
    'Ignore Words in Workspace Settings',
    fnWTarget(addIgnoreWordsToTarget, ConfigurationTarget.Workspace),
);
const actionAddIgnoreWordToUser = prompt('Ignore Words in User Settings', fnWTarget(addIgnoreWordsToTarget, ConfigurationTarget.Global));
const actionAddWordToCSpell = prompt('Add Words to cSpell Configuration', fnWTarget(addWordToTarget, dictionaryTargetBestMatchesCSpell));
const actionAddWordToDictionary = prompt('Add Words to Dictionary', fnWTarget(addWordToTarget, dictionaryTargetBestMatches));

export const commandHandlers = {
    'cSpell.addWordToDictionary': actionAddWordToDictionary,
    'cSpell.addWordToFolderDictionary': actionAddWordToFolder,
    'cSpell.addWordToWorkspaceDictionary': actionAddWordToWorkspace,
    'cSpell.addWordToUserDictionary': actionAddWordToUser,

    'cSpell.addWordToFolderSettings': actionAddWordToFolderSettings,
    'cSpell.addWordToWorkspaceSettings': actionAddWordToWorkspaceSettings,
    'cSpell.addWordToUserSettings': actionAddWordToUserSettings,

    'cSpell.removeWordFromFolderDictionary': actionRemoveWordFromFolderDictionary,
    'cSpell.removeWordFromWorkspaceDictionary': actionRemoveWordFromWorkspaceDictionary,
    'cSpell.removeWordFromUserDictionary': actionRemoveWordFromUserDictionary,

    'cSpell.addIgnoreWord': actionAddIgnoreWord,
    'cSpell.addIgnoreWordsToFolder': actionAddIgnoreWordToFolder,
    'cSpell.addIgnoreWordsToWorkspace': actionAddIgnoreWordToWorkspace,
    'cSpell.addIgnoreWordsToUser': actionAddIgnoreWordToUser,

    'cSpell.suggestSpellingCorrections': actionSuggestSpellingCorrections,

    'cSpell.goToNextSpellingIssue': () => actionJumpToSpellingError('next', false),
    'cSpell.goToPreviousSpellingIssue': () => actionJumpToSpellingError('previous', false),
    'cSpell.goToNextSpellingIssueAndSuggest': () => actionJumpToSpellingError('next', true),
    'cSpell.goToPreviousSpellingIssueAndSuggest': () => actionJumpToSpellingError('previous', true),

    'cSpell.enableForGlobal': async () => setEnableSpellChecking(await tsFCfg(ConfigurationTarget.Global), true),
    'cSpell.disableForGlobal': async () => setEnableSpellChecking(await tsFCfg(ConfigurationTarget.Global), false),
    'cSpell.toggleEnableForGlobal': async () => toggleEnableSpellChecker(await tsFCfg(ConfigurationTarget.Global, true)),
    'cSpell.enableForWorkspace': async () => setEnableSpellChecking(await tsFCfg(ConfigurationTarget.Workspace), true),
    'cSpell.disableForWorkspace': async () => setEnableSpellChecking(await tsFCfg(ConfigurationTarget.Workspace), false),
    'cSpell.toggleEnableForWorkspace': async () => toggleEnableSpellChecker(await tsFCfg(ConfigurationTarget.Workspace)),
    'cSpell.toggleEnableSpellChecker': async () => toggleEnableSpellChecker(await tsFCfg(ConfigurationTarget.Global)),
    'cSpell.enableCurrentFileType': enableCurrentFileType,
    'cSpell.disableCurrentFileType': disableCurrentFileType,

    'cSpell.editText': handleApplyLsTextEdits,
    'cSpell.logPerfTimeline': dumpPerfTimeline,

    'cSpell.openSettings': async () => executeOpenSettingsCommand(),

    'cSpell.addWordToCSpellConfig': actionAddWordToCSpell,
    'cSpell.addIssuesToDictionary': addAllIssuesFromDocument,
    'cSpell.createCustomDictionary': createCustomDictionary,
    'cSpell.createCSpellConfig': createCSpellConfig,

    'cSpell.openFileAtLine': openFileAtLine,

    'cSpell.selectRange': handleSelectRange,
    'cSpell.fixSpellingIssue': handleFixSpellingIssue,
    'cSpell.autoFixSpellingIssues': actionAutoFixSpellingIssues,

    'cSpell.issueViewer.item.openSuggestionsForIssue': handlerResolvedLater,
    'cSpell.issueViewer.item.autoFixSpellingIssues': handlerResolvedLater,
    'cSpell.issueViewer.item.addWordToDictionary': handlerResolvedLater,

    // 'cSpell.issuesViewByFile.item.openSuggestionsForIssue': handlerResolvedLater,
    'cSpell.issuesViewByFile.item.autoFixSpellingIssues': handlerResolvedLater,
    'cSpell.issuesViewByFile.item.addWordToDictionary': handlerResolvedLater,

    'cSpell.insertDisableNextLineDirective': handleInsertDisableNextLineDirective,
    'cSpell.insertDisableLineDirective': handleInsertDisableLineDirective,
    'cSpell.insertIgnoreWordsDirective': handleInsertIgnoreWordsDirective,
    'cSpell.insertWordsDirective': handleInsertWordsDirective,

    'cSpell.toggleTraceMode': handlerResolvedLater,
    'cSpell.toggleVisible': handlerResolvedLater,
    'cSpell.show': handlerResolvedLater,
    'cSpell.hide': handlerResolvedLater,
    'cSpell.createCSpellTerminal': handlerResolvedLater,

    'cspell.showActionsMenu': handlerResolvedLater,

    'cSpell.openIssuesPanel': genExecCommandFn('cSpellIssuesViewByFile.focus'),
    'cSpell.openFileInfoView': handleDisplayCSpellInfo,
    'cSpell.displayCSpellInfo': handleDisplayCSpellInfo,
    'cSpell.hideCSpellInfo': handleHideCSpellInfo,

    'cSpell.experimental.executeDocumentSymbolProvider': handleCmdExperimentalExecuteDocumentSymbolProvider,

    'cSpell.restart': handleRestart,
    'cSpell.reload': handleReload,

    'cSpell.supportRequest': supportRequest,
    'cSpell.reportIssue': reportIssue,
    'cSpell.about': about,
    'cSpell.sponsor': sponsor,
    'cSpell.rateTheSpellChecker': rateTheSpellChecker,
    'cSpell.releaseNotes': releaseNotes,

    // Deprecated Commands
    'cSpell.enableLanguage': enableLanguageIdCmd,
    'cSpell.disableLanguage': disableLanguageIdCmd,
    'cSpell.enableCurrentLanguage': enableCurrentFileType, // legacy
    'cSpell.disableCurrentLanguage': disableCurrentFileType, // legacy
} as const satisfies CommandHandlers;

type ImplementedCommandHandlers = typeof commandHandlers;
type ImplementedCommandNames = keyof ImplementedCommandHandlers;

export type InjectableCommandHandlers = Partial<ImplementedCommandHandlers>;

export const knownCommands = Object.fromEntries(
    Object.keys(commandHandlers).map((key) => [key, key] as [ImplementedCommandNames, ImplementedCommandNames]),
) as Record<ImplementedCommandNames, ImplementedCommandNames>;

export function registerCommands(injectCommands: InjectableCommandHandlers): Disposable[] {
    const skipRegister = new Set<string>();
    const registeredHandlers = Object.entries({ ...commandHandlers, ...injectCommands })
        .filter(([cmd]) => !skipRegister.has(cmd))
        .map(([cmd, fn]) => registerCmd(cmd, fn));
    const registeredFromServer = Object.entries(commandsFromServer).map(([cmd, fn]) => registerCmd(cmd, fn));
    return [
        ...registeredHandlers,
        ...registeredFromServer,
        // commands.registerTextEditorCommand(knownCommands['cSpell.insertDisableNextLineDirective'], handleInsertDisableNextLineDirective),
    ];
}

function handlerResolvedLater() {}

function addWordsToConfig(words: string[], cfg: ConfigRepository) {
    return handleErrors(di.get('dictionaryHelper').addWordsToConfigRep(words, cfg), 'addWordsToConfig');
}

function addWordsToDictionaryTarget(words: string[], dictTarget: DictionaryTarget) {
    return handleErrors(di.get('dictionaryHelper').addWordToDictionary(words, dictTarget), 'addWordsToDictionaryTarget');
}

// function removeWordsFromConfig(words: string[], cfg: ConfigRepository) {
//     return handleErrors(di.get('dictionaryHelper').removeWordsFromConfigRep(words, cfg));
// }

// function removeWordsFromDictionaryTarget(words: string[], dictTarget: DictionaryTarget) {
//     return handleErrors(di.get('dictionaryHelper').removeWordFromDictionary(words, dictTarget));
// }

function dispose() {}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registerCmd(cmd: string, fn: (...args: any[]) => unknown): Disposable {
    if (fn === handlerResolvedLater) {
        return { dispose };
    }
    return commands.registerCommand(cmd, catchErrors(fn, `Register command: ${cmd}`));
}

function addAllIssuesFromDocument(): Promise<void> {
    return handleErrors(di.get('dictionaryHelper').addIssuesToDictionary(), 'addAllIssuesFromDocument');
}

function addIgnoreWordsToTarget(
    word: string,
    target: ConfigurationTarget | undefined,
    uri: string | null | Uri | undefined,
): Promise<void> {
    return handleErrors(_addIgnoreWordsToTarget(word, target, uri), ctx('addIgnoreWordsToTarget', undefined, uri));
}

async function _addIgnoreWordsToTarget(
    word: string,
    target: ConfigurationTarget | undefined,
    uri: string | null | Uri | undefined,
): Promise<void> {
    uri = toUri(uri);
    const targets = await targetsForUri(uri);
    const filteredTargets = target ? targets.filter((t) => t.scope === configurationTargetToDictionaryScope(target)) : targets;
    return addIgnoreWordsToSettings(filteredTargets, word);
}

function removeWordFromFolderDictionary(word: string, uri: string | null | Uri | undefined): Promise<void> {
    return removeWordFromTarget(word, ConfigurationTarget.WorkspaceFolder, uri);
}

function removeWordFromWorkspaceDictionary(word: string, uri: string | null | Uri | undefined): Promise<void> {
    return removeWordFromTarget(word, ConfigurationTarget.Workspace, uri);
}

function removeWordFromUserDictionary(word: string): Promise<void> {
    return removeWordFromTarget(word, ConfigurationTarget.Global, undefined);
}

function removeWordFromTarget(word: string, target: ConfigurationTarget, uri: string | null | Uri | undefined) {
    return handleErrors(_removeWordFromTarget(word, target, uri), ctx('removeWordFromTarget', target, uri));
}

function _removeWordFromTarget(word: string, cfgTarget: ConfigurationTarget, docUri: string | null | Uri | undefined) {
    docUri = toUri(docUri);
    const target = createClientConfigTargetVSCode(cfgTarget, docUri, undefined);
    return di.get('dictionaryHelper').removeWordsFromTargets(word, [target], docUri);
}

export function enableLanguageIdCmd(languageId: string, uri?: Uri | string): Promise<void> {
    return enableDisableLanguageId(languageId, toUri(uri), undefined, true);
}

export function disableLanguageIdCmd(languageId: string, uri?: string | Uri): Promise<void> {
    return enableDisableLanguageId(languageId, toUri(uri), undefined, false);
}

export function enableDisableLanguageId(
    languageId: string,
    uri: Uri | undefined,
    configTarget: ConfigurationTarget | undefined,
    enable: boolean,
): Promise<void> {
    return handleErrors(
        async () => {
            const t = await (configTarget ? targetsFromConfigurationTarget(configTarget, uri) : targetsForUri(uri));
            return updateEnabledFileTypeForTarget({ [languageId]: enable }, t);
        },
        ctx(`enableDisableLanguageId enable: ${enable}`, configTarget, uri),
    );
}

export function enableDisableLocale(
    locale: string,
    uri: Uri | undefined,
    configTarget: ConfigurationTarget | undefined,
    configScope: ConfigurationScope | undefined,
    enable: boolean,
): Promise<void> {
    return handleErrors(
        async () => {
            const { targets, scopes } = await targetsAndScopeFromConfigurationTarget(
                configTarget || ConfigurationTarget.Global,
                uri,
                configScope,
            );
            return enableLocaleForTarget(locale, enable, targets, scopes);
        },
        ctx(`enableDisableLocale enable: ${enable}`, configTarget, uri),
    );
}

export function enableDisableLocaleLegacy(target: ConfigTargetLegacy | boolean, locale: string, enable: boolean): Promise<void> {
    const _target = typeof target === 'boolean' ? (target ? ConfigurationTarget.Global : ConfigurationTarget.Workspace) : target;
    const t = normalizeTarget(_target);
    return enableDisableLocale(locale, t.uri, t.target, t.configScope, enable);
}

export function enableCurrentFileType(languageId?: string, uri?: string | Uri): Promise<void> {
    const resolved = resolveLanguageIdAndUri(languageId, uri);
    return handleErrors(async () => {
        const { languageId, uri } = resolved;
        if (!uri || !languageId) return;
        return updateEnabledFileTypeForResource({ [languageId]: true }, uri);
    }, 'enableCurrentFileType');
}

export function disableCurrentFileType(languageId?: string, uri?: string | Uri): Promise<void> {
    const resolved = resolveLanguageIdAndUri(languageId, uri);
    return handleErrors(async () => {
        const { languageId, uri } = resolved;
        if (!uri || !languageId) return;
        return updateEnabledFileTypeForResource({ [languageId]: false }, uri);
    }, 'disableCurrentFileType');
}

function resolveLanguageIdAndUri(
    languageId?: string,
    uri?: string | Uri,
): { languageId: string | undefined; uri: Uri | string | undefined } {
    languageId = typeof languageId === 'string' ? languageId : undefined;
    uri = typeof uri === 'string' || uri instanceof Uri ? uri : undefined;
    const document = window.activeTextEditor?.document;
    uri ??= document?.uri;
    languageId ??= document?.languageId;
    return { languageId, uri };
}

function ctx(method: string, target: ConfigurationTarget | undefined, uri: Uri | string | null | undefined): string {
    const scope = target ? configurationTargetToDictionaryScope(target) : '';
    return scope ? `${method} ${scope} ${toUri(uri)}` : `${method} ${toUri(uri)}`;
}

async function createCustomDictionary(): Promise<void> {
    const targets = await targetsForTextDocument(window.activeTextEditor?.document);

    const t = await quickPickTarget(targets);
    if (!t) return;
    const cfg = configTargetToConfigRepo(t);
    if (!cfg) return;
    await di.get('dictionaryHelper').createCustomDictionary(cfg);
}

function dumpPerfTimeline(): void {
    performance.getEntries().forEach((entry) => {
        console.log(entry.name, toMilliseconds(entry.startTime), entry.duration);
    });
}

async function createCSpellConfig(): Promise<void> {
    const uri = await createConfigFileRelativeToDocumentUri(window.activeTextEditor?.document.uri);
    if (uri) {
        const editor = await window.showTextDocument(uri);
        // for `package.json` files, we might need to scroll to the right position.
        scrollToText(editor, '"cspell":');
    }
}

export const __testing__ = {
    commandHandlers,
};

function nextDiags(diags: Diagnostic[], selection: Selection): Diagnostic | undefined {
    // concat next diags with the first diag to get a cycle
    return diags.filter((d) => d.range?.start.isAfter(selection.end)).concat(diags[0])[0];
}

function previousDiags(diags: Diagnostic[], selection: Selection): Diagnostic | undefined {
    // concat the last diag with all previous diags to get a cycle
    return [diags[diags.length - 1]].concat(diags.filter((d) => d.range?.end.isBefore(selection.start))).pop();
}

async function actionJumpToSpellingError(which: 'next' | 'previous', suggest: boolean) {
    const editor = window.activeTextEditor;
    if (!editor) return;
    const document = editor.document;
    const selection = editor.selection;
    const diags = document ? getCSpellDiags(document.uri) : undefined;

    const matchingDiags = diags ? (which === 'next' ? nextDiags(diags, selection) : previousDiags(diags, selection)) : undefined;
    const range = matchingDiags?.range;
    if (!document || !selection || !range || !matchingDiags) {
        return pVoid(window.showInformationMessage('No issues found in this document.'), 'actionJumpToSpellingError');
    }

    editor.revealRange(range, TextEditorRevealType.InCenterIfOutsideViewport);
    editor.selection = new Selection(range.start, range.end);

    if (suggest) {
        return actionSuggestSpellingCorrections();
    }
}

async function openFileAtLine(uri: string | Uri, line: number | undefined): Promise<void> {
    uri = toUri(uri);

    const options =
        (line && {
            selection: lineToRange(line),
        }) ||
        undefined;

    await window.showTextDocument(uri, options);
}

function lineToRange(line: number | string | undefined) {
    if (line === undefined) return undefined;
    line = typeof line === 'string' ? Number.parseInt(line) : line;
    const pos = new Position(line - 1, 0);
    const range = new Range(pos, pos);
    return range;
}

export function createTextEditCommand(
    title: string,
    uri: string | Uri,
    documentVersion: number,
    edits: LsTextEdit[] | TextEdit[],
): Command {
    const normalizedEdits: LsTextEdit[] = edits.map(toLsTextEdit);
    return {
        title,
        command: 'cSpell.editText',
        arguments: [uri.toString(), documentVersion, normalizedEdits],
    };
}

/**
 * Create a href URL that will execute a command.
 */
export function commandUri(command: Command): string;
export function commandUri(command: string, ...params: unknown[]): string;
export function commandUri(command: string | Command, ...params: unknown[]): string {
    if (typeof command === 'string') {
        return `command:${command}?${encodeURIComponent(JSON.stringify(params))}`;
    }
    return `command:${command.command}?${command.arguments ? encodeURIComponent(JSON.stringify(command.arguments)) : ''}`;
}

function toLsPosition(p: LsPosition | Position): LsPosition {
    const { line, character } = p;
    return { line, character };
}

function toLsRange(range: LsRange | Range): LsRange {
    return {
        start: toLsPosition(range.start),
        end: toLsPosition(range.end),
    };
}

function toLsTextEdit(edit: LsTextEdit | TextEdit): LsTextEdit {
    const { range, newText } = edit;
    return {
        range: toLsRange(range),
        newText,
    };
}

async function handleSelectRange(uri?: Uri, range?: Range, cursorAtStart?: boolean): Promise<void> {
    if (!uri || !range) return;
    // const editor = findEditor(uri);
    // if (!editor) return;
    // editor.revealRange(range);
    // editor.selection = new Selection(range.start, range.end);
    try {
        const cell = findNotebookCell(uri);
        if (cell) {
            const notebook = cell.notebook;
            if (cell.index < 0) return;
            const nbRange = new NotebookRange(cell.index, cell.index + 1);
            await window.showNotebookDocument(notebook, { selections: [nbRange] });
        }
        const editor = await window.showTextDocument(uri, { selection: range });
        editor.selection = cursorAtStart ? new Selection(range.end, range.start) : new Selection(range.start, range.end);
    } catch (e) {
        logError(format('Error: handleSelectRange', e), uri.toString());
    }
}

const snippedBlockCommentStart = '${BLOCK_COMMENT_START/^(<!--)$/$1-/}';
const snippedBlockCommentEnd = '${BLOCK_COMMENT_END/^(-->)$/-$1/}';

function handleInsertDisableNextLineDirective(textEditor?: TextEditor, _edit?: TextEditorEdit): Promise<boolean | undefined> {
    return handleErrors(async () => {
        const editor = textEditor || window.activeTextEditor;
        if (!editor) return;
        const { document, selection } = editor;
        const { line } = selection.active;
        const textLine = document.lineAt(line);
        const prefix = textLine.text.slice(0, textLine.firstNonWhitespaceCharacterIndex);
        const suffix = textLine.text.length > textLine.firstNonWhitespaceCharacterIndex ? '\n' : '';
        return await editor.insertSnippet(
            new SnippetString(`${prefix}${snippedBlockCommentStart} cspell:disable-next-line ${snippedBlockCommentEnd}` + suffix),
            new Range(textLine.range.start, textLine.range.start),
        );
    }, 'handleInsertDisableNextLineDirective');
}

function handleInsertDisableLineDirective(textEditor?: TextEditor, _edit?: TextEditorEdit): Promise<boolean | undefined> {
    return handleErrors(async () => {
        const editor = textEditor || window.activeTextEditor;
        if (!editor) return;
        const { document, selection } = editor;
        const { line } = selection.active;
        const textLine = document.lineAt(line);
        const prefix = textLine.text.endsWith(' ') ? '' : ' ';
        return await editor.insertSnippet(
            new SnippetString(`${prefix}${snippedBlockCommentStart} cspell:disable-line ${snippedBlockCommentEnd}\n`),
            new Range(textLine.range.end, textLine.range.end),
        );
    }, 'handleInsertDisableLineDirective');
}

function handleInsertIgnoreWordsDirective(textEditor?: TextEditor, _edit?: TextEditorEdit): Promise<boolean | undefined> {
    return handleErrors(async () => {
        const editor = textEditor || window.activeTextEditor;
        if (!editor) return;
        const { document, selection } = editor;
        const { line } = selection.active;
        const textLine = document.lineAt(line);
        const prefix = textLine.text.slice(0, textLine.firstNonWhitespaceCharacterIndex);
        const suffix = textLine.text.length > textLine.firstNonWhitespaceCharacterIndex ? '\n' : '';
        return await editor.insertSnippet(
            new SnippetString(
                `${prefix}${snippedBlockCommentStart} cspell:ignore \${0:$TM_CURRENT_WORD} ${snippedBlockCommentEnd}` + suffix,
            ),
            new Range(textLine.range.start, textLine.range.start),
        );
    }, 'handleInsertIgnoreWordsDirective');
}

function handleInsertWordsDirective(textEditor?: TextEditor, _edit?: TextEditorEdit): Promise<boolean | undefined> {
    return handleErrors(async () => {
        const editor = textEditor || window.activeTextEditor;
        if (!editor) return;
        const { document, selection } = editor;
        const { line } = selection.active;
        const textLine = document.lineAt(line);
        const prefix = textLine.text.slice(0, textLine.firstNonWhitespaceCharacterIndex);
        const suffix = textLine.text.length > textLine.firstNonWhitespaceCharacterIndex ? '\n' : '';
        return await editor.insertSnippet(
            new SnippetString(
                `${prefix}${snippedBlockCommentStart} cspell:words \${0:$TM_CURRENT_WORD} ${snippedBlockCommentEnd}` + suffix,
            ),
            new Range(textLine.range.start, textLine.range.start),
        );
    }, 'handleInsertWordsDirective');
}

export type ExecuteCommand = Omit<Command, 'title'>;

async function execCommand<T = unknown>(command: ExecuteCommand): Promise<T> {
    const args = command.arguments || [];
    return commands.executeCommand<T>(command.command, ...args);
}

function genExecCommandFn<T>(command: string | ExecuteCommand): () => Promise<T> {
    return async () => {
        command = typeof command === 'string' ? { command } : command;
        return execCommand<T>(command);
    };
}

async function handleDisplayCSpellInfo() {
    await setContext({ displayCSpellInfo: true });
    await commands.executeCommand('cSpellInfoView.focus');
}

async function handleHideCSpellInfo() {
    await setContext({ displayCSpellInfo: false });
}

function handleRestart() {
    return handleErrors(di.getClient().restart(), 'handle restart server');
}

function handleReload() {
    return handleErrors(di.getClient().notifySettingsChanged(), 'handle restart server');
}

function handleCmdExperimentalExecuteDocumentSymbolProvider() {
    return handleErrors(experimentWithSymbols(), 'handleCmdExperimentalExecuteDocumentSymbolProvider');
}

export function generateOpenSettingsCommand(setting?: string): ExecuteCommand {
    const query = setting ? `${extensionSettings} ${setting}` : extensionSettings;
    return {
        command: 'workbench.action.openSettings',
        arguments: [{ query }],
    };
}

export function executeOpenSettingsCommand(setting?: string) {
    return execCommand(generateOpenSettingsCommand(setting));
}
