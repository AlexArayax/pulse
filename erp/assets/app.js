const bootstrapElement =
    document.getElementById('erp-bootstrap');

export const ERP = JSON.parse(
    bootstrapElement?.textContent || '{}'
);

const app = document.getElementById('app');

/*
 * Только действия ЧТЕНИЯ.
 *
 * Они могут сохраняться локально и возвращаться без сервера.
 * Не добавляйте сюда save/create/delete/send/update и т.п.
 */
const OFFLINE_READ_ACTIONS = new Set([
    'get',
    'list',
    'load',
    'search',
]);

/*
 * Дополнительные читающие действия конкретных модулей.
 *
 * Пример:
 *
 * const MODULE_OFFLINE_READ_ACTIONS = {
 *     products: new Set(['get_items', 'get_categories']),
 * };
 */
const MODULE_OFFLINE_READ_ACTIONS = {};

/*
 * Локальные данные доступны не более указанного времени.
 * Это политика интерфейса, а не серверная авторизация.
 */
const LOCAL_DATA_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const rootUrl = new URL('./', location.href);

const DB_NAME = `personal-erp-offline:${rootUrl.pathname}`;

const LOADER_KEY =
    `erp-offline-loader:${rootUrl.pathname}`;

let dbPromise = null;
let workerRegistration = null;

let currentModule = null;
let currentModuleName = '';
let openingModule = false;

let usingSnapshot = false;
let snapshotSavedAt = null;

let storageWarning = '';
let sessionExpired = false;

/* -------------------- IndexedDB -------------------- */

function openDb() {
    if (dbPromise) {
        return dbPromise;
    }

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);

        request.onupgradeneeded = () => {
            const db = request.result;

            if (!db.objectStoreNames.contains('context')) {
                db.createObjectStore('context');
            }

            if (!db.objectStoreNames.contains('snapshots')) {
                db.createObjectStore('snapshots');
            }
        };

        request.onsuccess = () => {
            const db = request.result;

            db.onversionchange = () => {
                db.close();
                dbPromise = null;
            };

            resolve(db);
        };

        request.onerror = () => {
            dbPromise = null;
            reject(request.error);
        };

        request.onblocked = () => {
            console.warn('ERP IndexedDB upgrade is blocked');
        };
    });

    return dbPromise;
}

async function dbGet(storeName, key) {
    const db = await openDb();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction(
            storeName,
            'readonly'
        );

        const request = transaction
            .objectStore(storeName)
            .get(key);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function dbWrite(storeName, key, value) {
    const db = await openDb();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction(
            storeName,
            'readwrite'
        );

        transaction.objectStore(storeName).put(value, key);

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(
            transaction.error || new Error('Storage transaction aborted')
        );
    });
}

async function clearLocalData() {
    const db = await openDb();

    await new Promise((resolve, reject) => {
        const transaction = db.transaction(
            ['context', 'snapshots'],
            'readwrite'
        );

        transaction.objectStore('context').clear();
        transaction.objectStore('snapshots').clear();

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(
            transaction.error || new Error('Storage cleanup aborted')
        );
    });
}

function showStorageWarning(error) {
    console.warn('ERP local storage error', error);

    storageWarning =
        'Локальное сохранение недоступно. ' +
        'Автономная работа может быть ограничена.';

    updateConnectionStatus();
}

/* -------------------- Локальный контекст -------------------- */

function assetUrl(path) {
    const base = new URL(
        `${String(ERP.assetsUrl || '').replace(/\/$/, '')}/`,
        location.href
    );

    return new URL(path, base);
}

function versionedAsset(path) {
    const url = assetUrl(path);
    url.searchParams.set('v', ERP.version || '1');
    return url.href;
}

async function saveOnlineContext() {
    const previous = await dbGet('context', 'current');

    /*
     * При смене пользователя удаляем прежние снимки.
     * Старые данные не должны становиться данными нового аккаунта.
     */
    if (
        previous?.bootstrap?.user?.id &&
        Number(previous.bootstrap.user.id) !== Number(ERP.user.id)
    ) {
        await clearLocalData();
    }

    const context = {
        savedAt: Date.now(),

        /*
         * Сохраняем только необходимое.
         * CSRF, JWT и пароль сюда не попадают.
         */
        bootstrap: {
            authenticated: true,
            routerUrl: ERP.routerUrl,
            assetsUrl: ERP.assetsUrl,
            appName: ERP.appName,
            version: ERP.version,

            user: {
                id: ERP.user.id,
                login: ERP.user.login,
                username: ERP.user.username,
                role: ERP.user.role,
            },

            modules: ERP.modules || {},
            chat: ERP.chat || {},
        },
    };

    await dbWrite('context', 'current', context);

    localStorage.setItem(LOADER_KEY, JSON.stringify({
        scriptUrl: versionedAsset('assets/app.js'),
        cssUrl: versionedAsset('assets/app.css'),
    }));
}

async function restoreOfflineContext() {
    const context = await dbGet('context', 'current');

    if (!context?.bootstrap?.user?.id) {
        throw new Error(
            'Нет сохранённого пользователя. ' +
            'Сначала войдите в ERP при доступном сервере.'
        );
    }

    if (
        Date.now() - context.savedAt >
        LOCAL_DATA_TTL_MS
    ) {
        throw new Error(
            'Срок локального доступа истёк. ' +
            'Откройте ERP с подключением к серверу.'
        );
    }

    Object.assign(ERP, context.bootstrap, {
        offlineShell: true,
        offline: true,
        csrf: null,
    });
}

/* -------------------- Снимки API -------------------- */

function isOfflineReadable(module, action) {
    return (
        OFFLINE_READ_ACTIONS.has(action) ||
        MODULE_OFFLINE_READ_ACTIONS[module]?.has(action) === true
    );
}

function stableValue(value) {
    if (Array.isArray(value)) {
        return value.map(stableValue);
    }

    if (
        value !== null &&
        typeof value === 'object'
    ) {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map(key => [key, stableValue(value[key])])
        );
    }

    return value;
}

function snapshotKey(body) {
    return JSON.stringify([
        Number(ERP.user?.id || 0),
        stableValue(body),
    ]);
}

async function saveSnapshot(body, result) {
    await dbWrite('snapshots', snapshotKey(body), {
        savedAt: Date.now(),
        result,
    });
}

async function readSnapshot(body) {
    const snapshot = await dbGet(
        'snapshots',
        snapshotKey(body)
    );

    if (!snapshot) {
        throw new Error(
            'Эти данные ещё не сохранены для автономной работы.'
        );
    }

    if (
        Date.now() - snapshot.savedAt >
        LOCAL_DATA_TTL_MS
    ) {
        throw new Error(
            'Сохранённые данные устарели. ' +
            'Требуется подключение к серверу.'
        );
    }

    usingSnapshot = true;
    snapshotSavedAt = snapshot.savedAt;

    updateConnectionStatus();

    /*
     * IndexedDB возвращает отдельную копию объекта.
     * Изменение результата модулем не меняет сам снимок.
     */
    return snapshot.result;
}

/* -------------------- Публичные функции -------------------- */

export function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

export async function api(module, action, data = {}) {
    /*
     * data не может переопределить module/action.
     * Ключ снимка строим из фактически отправляемого JSON.
     */
    const body = JSON.parse(JSON.stringify({
        ...data,
        module,
        action,
    }));

    const readable = isOfflineReadable(module, action);

    /*
     * В автономной оболочке нет актуального CSRF.
     * Возврат к серверной работе — через осознанную
     * перезагрузку страницы.
     */
    if (ERP.offlineShell || !navigator.onLine) {
        if (!readable) {
            throw new Error(
                'Эта операция требует подключения к серверу. ' +
                'Изменения на сервер не отправлены.'
            );
        }

        return readSnapshot(body);
    }

    let response;

    try {
        response = await fetch(ERP.routerUrl, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',

            headers: {
                'Content-Type':
                    'application/json; charset=utf-8',
                'X-CSRF-Token': ERP.csrf || '',
            },

            body: JSON.stringify(body),
        });
    } catch (cause) {
        if (readable) {
            try {
                return await readSnapshot(body);
            } catch (snapshotError) {
                const error = new Error(
                    'Сервер недоступен. ' +
                    snapshotError.message
                );

                error.code = 'NETWORK_ERROR';
                error.cause = cause;

                throw error;
            }
        }

        /*
         * Нельзя утверждать, что запись не произошла:
         * сервер мог выполнить её до потери ответа.
         */
        const error = new Error(
            'Ответ сервера не получен. ' +
            'Результат операции неизвестен. ' +
            'Не повторяйте её автоматически.'
        );

        error.code = 'NETWORK_ERROR';
        error.cause = cause;

        throw error;
    }

    let result;

    try {
        result = await response.json();
    } catch {
        throw new Error('Сервер вернул некорректный ответ');
    }

    if (
        response.status === 401 ||
        result?.code === 'not_logged'
    ) {
        sessionExpired = true;
        updateConnectionStatus();

        window.dispatchEvent(
            new CustomEvent('erp:session-expired')
        );

        const error = new Error(
            'Сессия завершена. Страница не перезагружена. ' +
            'Сохраните введённые данные и войдите повторно.'
        );

        error.code = 'SESSION_EXPIRED';

        throw error;
    }

    /*
     * Ошибки авторизации, прав и бизнес-логики не скрываем
     * подстановкой старого локального результата.
     */
    if (!response.ok || result?.status === 'error') {
        throw new Error(
            result?.message || 'Ошибка запроса'
        );
    }

    if (readable && ERP.user?.id) {
        try {
            await saveSnapshot(body, result);
        } catch (error) {
            showStorageWarning(error);
        }
    }

    return result;
}

export function getParam(name) {
    return new URL(location.href).searchParams.get(name);
}

export function setParams(values, replace = true) {
    const url = new URL(location.href);

    Object.entries(values).forEach(([key, value]) => {
        if (
            value === null ||
            value === undefined ||
            value === ''
        ) {
            url.searchParams.delete(key);
        } else {
            url.searchParams.set(key, String(value));
        }
    });

    history[replace ? 'replaceState' : 'pushState'](
        {},
        '',
        url.toString()
    );
}

export function createId() {
    if (crypto.randomUUID) {
        return crypto.randomUUID();
    }

    return (
        `${Date.now()}-` +
        Math.random().toString(16).slice(2)
    );
}

export function loadModuleCss(name) {
    const id = `erp-module-css-${name}`;

    if (document.getElementById(id)) {
        return;
    }

    const link = document.createElement('link');

    link.id = id;
    link.rel = 'stylesheet';
    link.href = versionedAsset(`modules/${name}.css`);

    document.head.appendChild(link);
}

/* -------------------- Статус подключения -------------------- */

function updateConnectionStatus() {
    let indicator =
        document.getElementById('erp-connection-status');

    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'erp-connection-status';

        Object.assign(indicator.style, {
            position: 'fixed',
            left: '12px',
            right: '12px',
            bottom: '12px',
            zIndex: '10000',
            padding: '10px 12px',
            borderRadius: '8px',
            background: '#795000',
            color: '#fff',
            boxShadow: '0 2px 12px #0003',
            font: '14px system-ui, sans-serif',
        });

        document.body.appendChild(indicator);
    }

    const messages = [];

    if (ERP.offlineShell) {
        messages.push(
            'Автономный режим: серверные изменения недоступны.'
        );
    } else if (!navigator.onLine) {
        messages.push(
            'Нет сети. Не закрывайте несохранённые формы.'
        );
    }

    if (usingSnapshot) {
        const time = snapshotSavedAt
            ? new Date(snapshotSavedAt).toLocaleString()
            : '';

        messages.push(
            `Используются сохранённые данные${time ? `: ${time}` : ''}.`
        );
    }

    if (sessionExpired) {
        messages.push(
            'Сессия завершена. Требуется повторный вход.'
        );
    }

    if (storageWarning) {
        messages.push(storageWarning);
    }

    indicator.replaceChildren();
    indicator.hidden = messages.length === 0;

    if (!messages.length) {
        return;
    }

    const text = document.createElement('span');
    text.textContent = messages.join(' ');

    indicator.appendChild(text);

    if (
        ERP.offlineShell ||
        usingSnapshot ||
        sessionExpired
    ) {
        const button = document.createElement('button');

        button.type = 'button';
        button.textContent = 'Открыть с сервера';
        button.style.marginLeft = '12px';

        button.onclick = () => {
            const confirmed = window.confirm(
                'Страница будет перезагружена. ' +
                'Несохранённые данные форм могут потеряться. Продолжить?'
            );

            if (confirmed) {
                location.assign(ERP.routerUrl || location.href);
            }
        };

        indicator.appendChild(button);
    }
}

window.addEventListener('online', updateConnectionStatus);
window.addEventListener('offline', updateConnectionStatus);

/* -------------------- Service Worker -------------------- */

async function registerWorker() {
    if (
        !('serviceWorker' in navigator) ||
        !window.isSecureContext
    ) {
        return;
    }

    const router = new URL(ERP.routerUrl, location.href);
    const workerRoot = new URL('./', router);
    const workerUrl = new URL('sw.js', workerRoot);

    const base = new URL(
        `${String(ERP.assetsUrl).replace(/\/$/, '')}/`,
        location.href
    );

    if (
        router.origin !== location.origin ||
        base.origin !== location.origin
    ) {
        throw new Error(
            'Для этого офлайн-режима ERP и ресурсы должны быть на одном origin.'
        );
    }

    workerUrl.searchParams.set('v', ERP.version || '1');
    workerUrl.searchParams.set('assets', base.href);
    workerUrl.searchParams.set('router', router.href);

    workerRegistration = await navigator.serviceWorker.register(
        workerUrl.href,
        {
            scope: workerRoot.pathname,
            updateViaCache: 'none',
        }
    );

    /*
     * ready может ожидать завершения первой установки.
     * Запуск интерфейса от этого не зависит.
     */
    navigator.serviceWorker.ready
        .then(() => {
            warmStaticCache();
        })
        .catch(console.warn);
}

function warmStaticCache(moduleName = null) {
    const worker =
        workerRegistration?.active ||
        navigator.serviceWorker?.controller;

    if (!worker) {
        return;
    }

    const urls = [
        versionedAsset('assets/app.js'),
        versionedAsset('assets/app.css'),
    ];

    const name = moduleName || currentModuleName;

    if (name) {
        urls.push(
            versionedAsset(`modules/${name}.js`),
            versionedAsset(`modules/${name}.css`)
        );
    }

    worker.postMessage({
        type: 'ERP_CACHE_URLS',
        urls,
    });
}

/* -------------------- Вход -------------------- */

function renderLogin() {
    if (ERP.offlineShell) {
        app.innerHTML = `
            <main class="login-page">
                <div class="login-card">
                    <h1>Автономный вход недоступен</h1>
                    <p>
                        Сначала войдите в ERP при доступном сервере.
                    </p>
                    <button type="button" id="erp-retry">
                        Повторить
                    </button>
                </div>
            </main>
        `;

        document.getElementById('erp-retry').onclick =
            () => location.reload();

        return;
    }

    app.innerHTML = `
        <main class="login-page">
            <form id="login-form" class="login-card">
                <h1>${escapeHtml(ERP.appName || 'ERP')}</h1>

                <label>
                    Логин
                    <input
                        name="login"
                        type="text"
                        autocomplete="username"
                        required
                    >
                </label>

                <label>
                    Пароль
                    <span class="password-field">
                        <input
                            name="password"
                            type="password"
                            autocomplete="current-password"
                            required
                        >
                        <button
                            id="show-password"
                            type="button"
                            aria-label="Показать пароль"
                        >◉</button>
                    </span>
                </label>

                <button class="primary-button" type="submit">
                    Войти
                </button>

                <div
                    id="login-message"
                    class="form-message"
                ></div>
            </form>
        </main>
    `;

    const form = document.getElementById('login-form');
    const password = form.elements.password;
    const message = document.getElementById('login-message');

    document.getElementById('show-password').onclick = () => {
        password.type = password.type === 'password'
            ? 'text'
            : 'password';
    };

    form.onsubmit = async event => {
        event.preventDefault();

        const submit = form.querySelector('[type="submit"]');

        submit.disabled = true;
        message.textContent = 'Вход...';

        try {
            const response = await fetch(ERP.routerUrl, {
                method: 'POST',
                credentials: 'same-origin',
                cache: 'no-store',

                headers: {
                    'Content-Type':
                        'application/json; charset=utf-8',
                },

                body: JSON.stringify({
                    action: 'login',
                    login: form.elements.login.value.trim(),
                    password: password.value,
                }),
            });

            const result = await response.json();

            if (
                !response.ok ||
                result.status !== 'ok'
            ) {
                throw new Error(
                    result.message || 'Ошибка входа'
                );
            }

            location.href = ERP.routerUrl;
        } catch (error) {
            message.textContent =
                error.message || 'Сервер недоступен';

            submit.disabled = false;
        }
    };
}

/* -------------------- Выход -------------------- */

async function handleLogout(event) {
    event.preventDefault();

    if (!window.confirm(
        'Выйти и удалить локально сохранённые данные ERP? ' +
        'Несохранённые формы будут закрыты.'
    )) {
        return;
    }

    try {
        await clearLocalData();
        localStorage.removeItem(LOADER_KEY);
    } catch (error) {
        alert(
            'Не удалось очистить локальные данные. ' +
            'Для полного удаления используйте настройки сайта в браузере.'
        );

        console.error(error);
        return;
    }

    if (ERP.offlineShell || !navigator.onLine) {
        /*
         * HttpOnly-cookie без сервера удалить нельзя.
         * Поэтому не выдаём локальный выход за серверный.
         */
        try {
            await currentModule?.destroy?.();
        } catch (error) {
            console.warn(error);
        }

        currentModule = null;
        currentModuleName = '';

        app.innerHTML = `
            <main class="login-page">
                <div class="login-card">
                    <h1>Локальные данные удалены</h1>
                    <p>
                        Серверная сессия не завершена:
                        для этого требуется связь с сервером.
                    </p>
                    <button type="button" id="erp-server-logout">
                        Завершить серверную сессию
                    </button>
                </div>
            </main>
        `;

        document.getElementById('erp-server-logout').onclick =
            () => {
                const url = new URL(
                    ERP.routerUrl,
                    location.href
                );

                url.searchParams.set('action', 'logout');
                location.assign(url.href);
            };

        return;
    }

    const url = new URL(ERP.routerUrl, location.href);
    url.searchParams.set('action', 'logout');

    location.assign(url.href);
}

/* -------------------- Приложение -------------------- */

function renderApplication() {
    const visibleModules = Object.entries(ERP.modules || {})
        .filter(([, module]) => !module.hidden);

    app.innerHTML = `
        <div class="erp-shell">
            <header class="erp-header">
                <strong class="erp-header-title">
                    ${escapeHtml(ERP.appName || 'ERP')}
                </strong>

                <nav
                    id="module-tabs"
                    class="module-tabs"
                    aria-label="Модули"
                >
                    ${visibleModules.map(([name, module]) => `
                        <button
                            type="button"
                            class="module-tab"
                            data-module="${escapeHtml(name)}"
                        >${escapeHtml(module.title || name)}</button>
                    `).join('')}
                </nav>

                <span class="erp-header-user">
                    <span class="erp-header-username">
                        ${escapeHtml(
                            ERP.user?.username ||
                            ERP.user?.login ||
                            ''
                        )}
                    </span>

                    <a href="#" id="erp-logout">
                        Выйти
                    </a>
                </span>
            </header>

            <main
                id="module-panel"
                class="module-panel"
            ></main>
        </div>
    `;

    document.getElementById('erp-logout')
        .addEventListener('click', handleLogout);

    document.getElementById('module-tabs').onclick = event => {
        const button =
            event.target.closest('[data-module]');

        if (button) {
            void openModule(button.dataset.module);
        }
    };

    const requested = getParam('module');
    const firstModule = visibleModules[0]?.[0];

    const initial =
        requested && ERP.modules[requested]
            ? requested
            : firstModule;

    if (initial) {
        void openModule(initial, {
            preserveParams: true,
        });
    }
}

async function openModule(
    name,
    { preserveParams = false } = {}
) {
    if (
        !ERP.modules?.[name] ||
        currentModuleName === name ||
        openingModule
    ) {
        return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        return;
    }

    const panel = document.getElementById('module-panel');

    if (!panel) {
        return;
    }

    openingModule = true;

    let imported;

    /*
     * Сначала загружаем новый JS.
     * Если его нет офлайн, старый модуль остаётся открытым.
     */
    try {
        imported = await import(
            versionedAsset(`modules/${name}.js`)
        );

        if (typeof imported.default !== 'function') {
            throw new Error(
                `Модуль ${name} не экспортирует класс`
            );
        }
    } catch (error) {
        openingModule = false;

        const message =
            'Не удалось открыть модуль. ' +
            'Без сети доступны только ранее загруженные файлы. ' +
            (error.message || '');

        if (currentModule) {
            alert(message);
        } else {
            panel.innerHTML = `
                <div class="error-box">
                    ${escapeHtml(message)}
                </div>
            `;
        }

        return;
    }

    try {
        await currentModule?.destroy?.();

        currentModule = null;
        currentModuleName = '';

        loadModuleCss(name);

        panel.innerHTML =
            '<div class="loading">Загрузка...</div>';

        if (preserveParams) {
            setParams({ module: name });
        } else {
            setParams({
                module: name,
                id: null,
                pass: null,
            });
        }

        currentModule = new imported.default({
            name,
            panel,

            api: (action, data = {}) =>
                api(name, action, data),

            rootApi: api,
            bootstrap: ERP,
            setParams,
            getParam,
        });

        currentModuleName = name;

        document.querySelectorAll('.module-tab')
            .forEach(tab => {
                const selected =
                    tab.dataset.module === name;

                tab.classList.toggle('selected', selected);

                if (selected) {
                    tab.setAttribute('aria-current', 'page');
                } else {
                    tab.removeAttribute('aria-current');
                }
            });

        warmStaticCache(name);
    } catch (error) {
        panel.innerHTML = `
            <div class="error-box">
                ${escapeHtml(error.message || 'Ошибка модуля')}
            </div>
        `;
    } finally {
        openingModule = false;
    }
}

window.addEventListener('popstate', () => {
    const name = getParam('module');

    if (name && name !== currentModuleName) {
        void openModule(name, {
            preserveParams: true,
        });
    }
});

/* -------------------- Запуск -------------------- */

async function start() {
    if (ERP.offlineShell) {
        try {
            await restoreOfflineContext();
        } catch (error) {
            app.innerHTML = `
                <main class="login-page">
                    <div class="login-card">
                        <h1>Автономный запуск недоступен</h1>
                        <p>${escapeHtml(error.message)}</p>
                        <button
                            type="button"
                            id="erp-offline-retry"
                        >
                            Повторить загрузку
                        </button>
                    </div>
                </main>
            `;

            document.getElementById('erp-offline-retry')
                .onclick = () => location.reload();

            return;
        }
    } else if (ERP.authenticated && ERP.user?.id) {
        try {
            await saveOnlineContext();
        } catch (error) {
            showStorageWarning(error);
        }
    } else {
        /*
         * Если сервер сообщил, что пользователь не вошёл,
         * старый локальный контекст больше не используем.
         */
        try {
            await clearLocalData();
            localStorage.removeItem(LOADER_KEY);
        } catch (error) {
            showStorageWarning(error);
        }
    }

    if (ERP.authenticated) {
        renderApplication();

        if (!ERP.offlineShell) {
            registerWorker().catch(error => {
                console.error(
                    'ERP Service Worker registration failed',
                    error
                );

                storageWarning =
                    'Не удалось подготовить автономную загрузку.';

                updateConnectionStatus();
            });
        }
    } else {
        renderLogin();
    }

    updateConnectionStatus();
}

void start().catch(error => {
    console.error('ERP startup failed', error);

    app.innerHTML = `
        <div class="error-box">
            ${escapeHtml(error.message || 'Ошибка запуска ERP')}
        </div>
    `;
});