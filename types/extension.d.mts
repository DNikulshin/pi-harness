/** Подкоманды `/cycle`. */
export declare const SUBCOMMANDS: readonly string[];
/**
 * Текст о состоянии цикла для человека.
 * @param {import('./core.mjs').CoreState} state снимок состояния ядра
 * @returns {string} строка статуса
 */
export declare function statusLine(state: import('./core.mjs').CoreState): string;
/**
 * Подсказка по подкомандам.
 * @returns {string} текст
 */
export declare function helpText(): string;
/**
 * Первое слово аргументов — подкоманда.
 * @param {string} args аргументы команды
 * @returns {string} подкоманда (по умолчанию `next`)
 */
export declare function parseSubcommand(args: string): string;
/**
 * Фабрика расширения Pi. Экспорт по умолчанию — то, что загружает Pi.
 * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi API расширения
 */
export default function extension(pi: import('@earendil-works/pi-coding-agent').ExtensionAPI): void;
