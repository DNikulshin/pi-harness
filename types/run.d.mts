export type RunOutcome = {
    /**
     * сколько команд исполнено
     */
    executed: number;
    /**
     * первая упавшая команда
     */
    failed: {
        command: string;
        code: number;
    } | null;
    /**
     * текст отказа драйвера
     */
    error: string | null;
    /**
     * план остановки (если драйвер упёрся в неисполняемый шаг)
     */
    stop: import('./driver.mjs').StepPlan | null;
    /**
     * код возврата процесса
     */
    code: number;
};
/**
 * Что вернул `run --max-steps 1`.
 * @typedef {object} RunOutcome
 * @property {number} executed сколько команд исполнено
 * @property {{command: string, code: number} | null} failed первая упавшая команда
 * @property {string | null} error текст отказа драйвера
 * @property {import('./driver.mjs').StepPlan | null} stop план остановки (если драйвер упёрся в неисполняемый шаг)
 * @property {number} code код возврата процесса
 */
/**
 * Разбор ответа `run`.
 *
 * Тонкость: при `--max-steps 1` драйвер сначала исполняет шаг, потом упирается в собственный лимит
 * и возвращает `{executed:[…], error:'лимит шагов'}` с кодом 1. Это не отказ, а признак «шаг
 * сделан»: различаем по непустому `executed` и по отсутствию упавшей команды.
 * @param {unknown} json разобранный JSON
 * @param {number} code код возврата
 * @returns {RunOutcome} итог шага
 */
export declare function parseRunOutcome(json: unknown, code: number): RunOutcome;
export type RunDeps = {
    /**
     * получить план шага
     */
    next: () => Promise<{
        json: unknown;
        code: number;
    }>;
    /**
     * исполнить один шаг
     */
    runOne: () => Promise<{
        json: unknown;
        code: number;
    }>;
    /**
     * спросить владельца
     */
    confirm: (text: string) => Promise<boolean>;
    /**
     * показать текст
     */
    notify: (text: string, level: import('./driver.mjs').NotifyLevel) => void;
    /**
     * предел шагов за один вызов
     */
    maxSteps?: number;
};
export type RunReport = {
    /**
     * сколько шагов исполнено
     */
    steps: number;
    /**
     * на чём остановились: `done` | `spawn` | `handoff` | `stop` |
     * `blocked` | `declined` | `failed` | `limit`
     */
    stopped: string;
    /**
     * последний увиденный план
     */
    plan: import('./driver.mjs').StepPlan | null;
};
/**
 * Зависимости прогона — подставляются в тестах.
 * @typedef {object} RunDeps
 * @property {() => Promise<{json: unknown, code: number}>} next получить план шага
 * @property {() => Promise<{json: unknown, code: number}>} runOne исполнить один шаг
 * @property {(text: string) => Promise<boolean>} confirm спросить владельца
 * @property {(text: string, level: import('./driver.mjs').NotifyLevel) => void} notify показать текст
 * @property {number} [maxSteps] предел шагов за один вызов
 */
/**
 * Итог `/cycle run`.
 * @typedef {object} RunReport
 * @property {number} steps сколько шагов исполнено
 * @property {string} stopped на чём остановились: `done` | `spawn` | `handoff` | `stop` |
 *   `blocked` | `declined` | `failed` | `limit`
 * @property {import('./driver.mjs').StepPlan | null} plan последний увиденный план
 */
/**
 * Прогон цикла: шаг — подтверждение — исполнение, до остановки.
 * @param {RunDeps} deps зависимости
 * @returns {Promise<RunReport>} итог
 */
export declare function runCycle(deps: RunDeps): Promise<RunReport>;
