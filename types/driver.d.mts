export type NotifyLevel = 'info' | 'warning' | 'error';
/** Уровень уведомления Pi: тот же набор, что в `ctx.ui.notify`. */
/** @typedef {'info' | 'warning' | 'error'} NotifyLevel */
/** Версия формы ответа драйвера, которую понимает адаптер. */
export declare const SUPPORTED_CONTRACT = "cycle-driver.next/1";
/** Действия, которые драйвер исполняет без человека. */
export declare const EXECUTABLE_ACTIONS: Readonly<Set<string>>;
/** Действия, на которых адаптер останавливается: работу делает человек или другая сессия. */
export declare const STOP_ACTIONS: Readonly<Set<string>>;
/** Стадии, вход в которые требует подтверждения владельца (#3). */
export declare const CONFIRM_TARGETS: Readonly<Set<string>>;
/** Имя `bin` драйвера в пакете ядра. */
export declare const DRIVER_BIN = "harness-cycle-driver";
/** Сколько шагов адаптер исполняет за один `/cycle run`; дальше — новый вопрос человеку. */
export declare const MAX_STEPS_PER_RUN = 10;
/**
 * Путь к `bin` драйвера в проекте.
 * @param {string} root корень проекта
 * @returns {string | null} путь или `null`, если ядро не установлено
 */
export declare function driverPath(root: string): string | null;
export type DriverResult = {
    /**
     * код возврата (0 — шаг определён или исполнен, 1 — `blocked`/остановка,
     * 2 — ошибка использования или данных, 3/4 — коды подпроцессов ядра)
     */
    code: number;
    /**
     * разобранный JSON ответа (`null`, если тело не JSON)
     */
    json: unknown;
    /**
     * текст ошибки драйвера (или `stderr` процесса)
     */
    stderr: string;
};
/**
 * Ответ драйвера.
 * @typedef {object} DriverResult
 * @property {number} code код возврата (0 — шаг определён или исполнен, 1 — `blocked`/остановка,
 *   2 — ошибка использования или данных, 3/4 — коды подпроцессов ядра)
 * @property {unknown} json разобранный JSON ответа (`null`, если тело не JSON)
 * @property {string} stderr текст ошибки драйвера (или `stderr` процесса)
 */
/**
 * Запуск подкоманды драйвера.
 * @param {{root: string, args: string[]}} params корень проекта и аргументы после подкоманды
 * @returns {Promise<DriverResult>} код и разобранный ответ
 */
export declare function callDriver({ root, args }: {
    root: string;
    args: string[];
}): Promise<DriverResult>;
export type StepPlan = {
    /**
     * версия формы
     */
    contract: string;
    /**
     * `run` | `advance` | `finish` | `spawn` | `handoff` | `stop` | `blocked`
     */
    action: string;
    /**
     * токен детерминированного скрипта
     */
    step: string | null;
    /**
     * стадия
     */
    stage: string;
    /**
     * статус стадии
     */
    status: string;
    /**
     * стадия перехода
     */
    target: string | null;
    /**
     * причина решения
     */
    reason: string;
    /**
     * чего ждёт цикл
     */
    waitingFor: string | null;
    /**
     * готовые команды
     */
    commands: string[];
    /**
     * каталог цикла из `cycle.dir` — по нему читаются артефакты
     */
    cycleDir: string | null;
    /**
     * блок `cycle` (итерация, ветка, подтверждение, эскалация)
     */
    cycle: object | null;
    /**
     * блок `done` (история и счётчики журнала)
     */
    done: object | null;
};
/**
 * План шага из ответа `next`.
 * @typedef {object} StepPlan
 * @property {string} contract версия формы
 * @property {string} action `run` | `advance` | `finish` | `spawn` | `handoff` | `stop` | `blocked`
 * @property {string | null} step токен детерминированного скрипта
 * @property {string} stage стадия
 * @property {string} status статус стадии
 * @property {string | null} target стадия перехода
 * @property {string} reason причина решения
 * @property {string | null} waitingFor чего ждёт цикл
 * @property {string[]} commands готовые команды
 * @property {string | null} cycleDir каталог цикла из `cycle.dir` — по нему читаются артефакты
 * @property {object | null} cycle блок `cycle` (итерация, ветка, подтверждение, эскалация)
 * @property {object | null} done блок `done` (история и счётчики журнала)
 */
/**
 * Разбор и проверка ответа `next` против контракта.
 * @param {unknown} json разобранный ответ
 * @returns {StepPlan} план шага
 * @throws {Error} если ответ не по контракту или версия формы чужая
 */
export declare function parseStepPlan(json: unknown): StepPlan;
/**
 * Нужно ли подтверждение владельца перед исполнением шага.
 *
 * Подтверждение нужно на входе в `PR` и `ESCALATED` (issue #3): это переходы, после которых
 * работа уходит человеку или проект получает эскалацию, и отменить их из адаптера нечем.
 * `blocked` — не переход, а остановка: она показывается, но не подтверждается.
 * @param {StepPlan} plan план шага
 * @returns {boolean} `true`, если спрашивать владельца
 */
export declare function needsConfirmation(plan: StepPlan): boolean;
/**
 * Человекочитаемый вид плана шага для `/cycle next`.
 * @param {StepPlan} plan план шага
 * @returns {string} текст для `ui.notify`
 */
export declare function describePlan(plan: StepPlan): string;
