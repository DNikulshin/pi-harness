/**
 * Текст о состоянии цикла для человека. Шаг 1 показывает только совместимость и версии: шаг,
 * артефакты и переходы появятся на шагах 2–3.
 * @param {import('./core.mjs').CoreState} state снимок состояния ядра
 * @returns {string} строка статуса
 */
export declare function statusLine(state: import('./core.mjs').CoreState): string;
/**
 * Фабрика расширения Pi. Экспорт по умолчанию — то, что загружает Pi.
 * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi API расширения
 */
export default function extension(pi: import('@earendil-works/pi-coding-agent').ExtensionAPI): void;
