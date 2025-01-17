/* eslint-disable @typescript-eslint/no-explicit-any */
export enum LogLevel {
    none = 0,
    debug = 1,
    info = 2,
    warn = 3,
    error = 4,
}

// let logLevel = LogLevel.error;
// let logLevel = LogLevel.debug;
let logLevel = LogLevel.none;

export const log = makeLogger(console.log, LogLevel.info);
export const error = makeLogger(console.error, LogLevel.error);
export const warn = makeLogger(console.warn, LogLevel.warn);
export const info = makeLogger(console.info, LogLevel.info);
export const debug = makeLogger(console.debug, LogLevel.debug);

export function setLogLevel(level: LogLevel) {
    logLevel = level;
}

export function getLogLevel(): LogLevel {
    return logLevel;
}

function makeLogger(logFn: (...p: any[]) => void, level: LogLevel) {
    return function (...params: any[]) {
        if (!logLevel || level < logLevel) return;
        logFn(...params);
    };
}
