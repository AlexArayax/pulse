import ChatView, { createId, makeError, escapeHtml, attachmentError } from './chat-view.js';

const AI_MODES = new Set(['off', 'post', 'summary', 'dialog', 'image']);
const VISIBLE_TYPES = new Set(['text', 'image', 'file']);
const IMAGE_LIMIT = 10;
const FILE_LIMIT = 20;
const TEXT_LIMIT = 50000;

function asMode(value) {
    return AI_MODES.has(value) ? value : 'off';
}

function isImage(file) {
    return /^image\//i.test(file.type) || /\.(?:jpe?g|png|gif|webp|avif|heic|heif|bmp|tiff?)$/i.test(file.name);
}

function networkError(message, cause) {
    return Object.assign(makeError(message), { network: true, cause });
}

class ChatLocal {
    constructor(context) {
        this.context = context;
        this.userId = Number(context.bootstrap.user?.id || 0);
        this.dbName = `personal-erp-offline:${new URL('./', location.href).pathname}`;
        this.prefix = `chat-local-v1:${this.userId}:`;
        this.online = false;
        this.dbPromise = null;
        this.sessionPromise = null;
        this.locks = new Map();
    }

    db() {
        if (!this.dbPromise) {
            this.dbPromise = new Promise((resolve, reject) => {
                const request = indexedDB.open(this.dbName, 1);
                request.onupgradeneeded = () => {
                    for (const name of ['context', 'snapshots']) {
                        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
                    }
                };
                request.onsuccess = () => {
                    const db = request.result;
                    db.onversionchange = () => {
                        db.close();
                        this.dbPromise = null;
                    };
                    resolve(db);
                };
                request.onerror = () => {
                    this.dbPromise = null;
                    reject(request.error);
                };
            });
        }
        return this.dbPromise;
    }

    async transaction(mode, operation) {
        const db = await this.db();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('snapshots', mode);
            const result = operation(tx.objectStore('snapshots'));
            tx.oncomplete = () => resolve(result?.result);
            tx.onerror = tx.onabort = () => reject(tx.error || makeError('Ошибка локальной БД'));
        });
    }

    get(key) {
        return this.transaction('readonly', store => store.get(this.prefix + key));
    }

    put(key, value) {
        return this.transaction('readwrite', store => store.put(value, this.prefix + key));
    }

    remove(keys) {
        if (!keys.length) return Promise.resolve();
        return this.transaction('readwrite', store => {
            for (const key of keys) store.delete(this.prefix + key);
        });
    }

    serialize(key, callback) {
        const next = (this.locks.get(key) || Promise.resolve()).catch(() => {}).then(callback);
        this.locks.set(key, next);
        next.finally(() => {
            if (this.locks.get(key) === next) this.locks.delete(key);
        }).catch(() => {});
        return next;
    }

    emptyChat() {
        return { cursor: 0, messages: {}, deleted: [], meta: null, savedAt: 0 };
    }

    async ensureSession() {
        const bootstrap = this.context.bootstrap;
        if (!bootstrap.offlineShell && bootstrap.csrf) return;
        if (this.sessionPromise) return this.sessionPromise;
        this.sessionPromise = (async () => {
            const url = new URL(bootstrap.routerUrl, location.href);
            url.search = '';
            url.hash = '';
            const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
            if (!response.ok) throw makeError('Не удалось проверить серверную сессию', response.status);
            const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
            let fresh;
            try {
                fresh = JSON.parse(doc.getElementById('erp-bootstrap')?.textContent || '{}');
            } catch {
                throw makeError('Некорректный bootstrap сервера');
            }
            if (!fresh.authenticated || Number(fresh.user?.id) !== this.userId || !fresh.csrf) {
                throw makeError('Требуется повторный вход тем же пользователем', 401);
            }
            if (!fresh.modules?.chat) throw makeError('Доступ к чату отозван', 403);
            Object.assign(bootstrap, { csrf: fresh.csrf, offlineShell: false, offline: false });
        })();
        try {
            await this.sessionPromise;
        } finally {
            this.sessionPromise = null;
        }
    }

    async request(action, data = {}, binary = false) {
        if (!navigator.onLine) {
            this.online = false;
            throw networkError('Нет подключения');
        }
        try {
            await this.ensureSession();
        } catch (error) {
            this.online = false;
            if (error instanceof TypeError) throw networkError('Сервер недоступен', error);
            throw error;
        }
        const bootstrap = this.context.bootstrap;
        const multipart = data instanceof FormData;
        const headers = { 'X-CSRF-Token': bootstrap.csrf || '' };
        if (!multipart) headers['Content-Type'] = 'application/json; charset=utf-8';
        let response;
        try {
            response = await fetch(bootstrap.routerUrl, {
                method: 'POST',
                credentials: 'same-origin',
                cache: 'no-store',
                headers,
                body: multipart ? data : JSON.stringify({ ...data, module: 'chat', action })
            });
        } catch (cause) {
            this.online = false;
            throw networkError('Сервер недоступен', cause);
        }
        if (response.status === 401) {
            this.online = false;
            bootstrap.csrf = null;
            window.dispatchEvent(new CustomEvent('erp:session-expired'));
        }
        if (binary && response.ok) {
            const type = response.headers.get('Content-Type') || '';
            if (!/application\/json|text\/html/i.test(type)) {
                this.online = true;
                return response;
            }
            if (/text\/html/i.test(type)) throw makeError('Вместо вложения сервер вернул HTML', response.status);
        }
        let result;
        try {
            result = await response.json();
        } catch {
            throw makeError('Некорректный ответ сервера', response.status);
        }
        if (!response.ok || result?.status === 'error' || binary) {
            throw makeError(result?.message || 'Ошибка запроса', response.status);
        }
        this.online = true;
        return result;
    }

    applyEvents(state, events) {
        const deleted = new Set((state.deleted || []).map(Number));
        const files = [];
        const upsert = message => {
            const id = Number(message?.id);
            if (!Number.isSafeInteger(id) || id <= 0 || deleted.has(id)) return;
            const old = state.messages[id];
            const incoming = structuredClone(message);
            if (old && Number(old.revision || 0) > Number(incoming.revision || 0)) return;
            if (old && Number(old.reaction_version || 0) > Number(incoming.reaction_version || 0)) {
                incoming.reactions = old.reactions;
                incoming.reaction_version = old.reaction_version;
            }
            state.messages[id] = { ...old, ...incoming };
        };
        for (const event of events || []) {
            if (!event) continue;
            if (event.type === 'delete') {
                const id = Number(event.body);
                if (!Number.isSafeInteger(id) || id <= 0) continue;
                deleted.add(id);
                delete state.messages[id];
                files.push(`file:${id}`);
            } else if (event.type === 'edit') {
                upsert(event.message);
            } else if (event.type === 'reaction') {
                const message = state.messages[Number(event.message_id)];
                if (message && Number(event.reaction_version || 0) >= Number(message.reaction_version || 0)) {
                    message.reactions = structuredClone(event.reactions || []);
                    message.reaction_version = Number(event.reaction_version || 0);
                }
            } else if (VISIBLE_TYPES.has(event.type)) {
                upsert(event);
            }
        }
        state.deleted = [...deleted];
        state.savedAt = Date.now();
        return files;
    }

    saveEvents(chatId, events) {
        return this.serialize(`chat:${chatId}`, async () => {
            const key = `chat:${chatId}`;
            const state = await this.get(key) || this.emptyChat();
            const files = this.applyEvents(state, events);
            await this.put(key, state);
            await this.remove(files);
        });
    }

    async cacheEvents(chatId, events) {
        if (!Number.isSafeInteger(chatId) || !events.length) return;
        try {
            await this.saveEvents(chatId, events);
        } catch (error) {
            console.error('Chat event cache failed', error);
        }
    }

    forgetChat(chatId) {
        return this.serialize(`chat:${chatId}`, async () => {
            const state = await this.get(`chat:${chatId}`);
            await this.remove([`chat:${chatId}`, ...Object.keys(state?.messages || {}).map(id => `file:${id}`)]);
        });
    }

    saveChatList(response, initial = false) {
        return this.serialize('meta', async () => {
            const previous = await this.get('meta');
            const allowed = new Set((response.chats || []).map(chat => Number(chat.chat)));
            for (const chat of previous?.chats || []) {
                if (!allowed.has(Number(chat.chat))) await this.forgetChat(Number(chat.chat));
            }
            await this.put('meta', {
                ...previous,
                ...(initial ? response : {}),
                status: 'ok',
                chats: response.chats || [],
                savedAt: Date.now()
            });
        });
    }

    async cachedPoll(chatId, lastId) {
        const state = await this.get(`chat:${chatId}`);
        if (!state) throw makeError('История этого чата ещё не сохранена в браузере');
        const meta = await this.get('meta');
        if (!meta?.chats?.some(chat => Number(chat.chat) === chatId)) {
            throw makeError('Нет локального доступа к чату', 403);
        }
        return {
            status: 'ok',
            initial: lastId === 0,
            messages: lastId === 0 ? this.sortedMessages(state) : [],
            last_message_id: lastId === 0 ? Number(state.cursor || 0) : lastId,
            has_more: false,
            chat: state.meta,
            offlineCached: true
        };
    }

    sortedMessages(state) {
        return Object.values(state.messages).sort((a, b) => Number(a.id) - Number(b.id));
    }

    poll(data) {
        const chatId = Number(data.chat || 0);
        const requested = Number(data.lastId || 0);
        return this.serialize(`chat:${chatId}`, async () => {
            const key = `chat:${chatId}`;
            const state = await this.get(key) || this.emptyChat();
            let cursor = requested === 0 ? Number(state.cursor || 0) : requested;
            let latest;
            let remaining = false;
            try {
                do {
                    latest = await this.request('poll', { chat: chatId, lastId: cursor });
                    const files = this.applyEvents(state, latest.messages || []);
                    const next = Number(latest.last_message_id ?? cursor);
                    state.cursor = Math.max(Number(state.cursor || 0), next);
                    state.meta = latest.chat || state.meta;
                    await this.put(key, state);
                    await this.remove(files);
                    remaining = latest.has_more === true && next > cursor;
                    cursor = next;
                } while (requested === 0 && remaining);
                if (requested !== 0) return latest;
                return {
                    status: 'ok',
                    initial: true,
                    messages: this.sortedMessages(state),
                    last_message_id: state.cursor,
                    has_more: remaining,
                    chat: state.meta
                };
            } catch (error) {
                if (!error.network) throw error;
                this.online = false;
                return this.cachedPoll(chatId, requested);
            }
        });
    }

    async api(action, data = {}) {
        if (action === 'poll') return this.poll(data);
        if (action === 'init' || action === 'status') {
            try {
                const response = await this.request(action, data);
                await this.saveChatList(response, action === 'init');
                return response;
            } catch (error) {
                if (!error.network) throw error;
                const meta = await this.get('meta');
                if (!meta) throw error;
                this.online = false;
                return { ...meta, offlineCached: true };
            }
        }
        const response = await this.request(action, data);
        if ((action === 'send' || action === 'editMessage') && response.message) {
            await this.cacheEvents(Number(data.chat ?? response.chat?.chat ?? response.chatId), [response.message]);
        } else if (action === 'deleteMessage') {
            await this.cacheEvents(Number(data.chat ?? response.chat?.chat), [{ type: 'delete', body: String(data.id) }]);
        } else if (action === 'setReaction') {
            await this.cacheEvents(Number(response.chatId ?? data.chat), [{ ...response, type: 'reaction' }]);
        } else if ((action === 'createChat' && response.chat) || action === 'leaveChat') {
            await this.serialize('meta', async () => {
                const chatId = Number(response.chat?.chat ?? data.chat);
                if (action === 'leaveChat') await this.forgetChat(chatId);
                const meta = await this.get('meta');
                if (!meta) return;
                meta.chats = (meta.chats || []).filter(chat => Number(chat.chat) !== chatId);
                if (action === 'createChat') meta.chats.push(response.chat);
                await this.put('meta', meta);
            }).catch(error => console.error('Chat list cache failed', error));
        }
        return response;
    }

    cachedFile(id) {
        return this.get(`file:${Number(id)}`);
    }

    async file(id, chatId) {
        id = Number(id);
        chatId = Number(chatId);
        const meta = await this.get('meta');
        const chat = await this.get(`chat:${chatId}`);
        if (!meta?.chats?.some(item => Number(item.chat) === chatId) || !chat?.messages?.[id] || chat.deleted?.includes(id)) {
            throw makeError('Вложение недоступно', 403);
        }
        try {
            const response = await this.request('download', { id }, true);
            const disposition = response.headers.get('Content-Disposition') || '';
            let filename = disposition.match(/filename="([^"]+)"/i)?.[1] || chat.messages[id].file_name || `attachment-${id}`;
            const utf = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
            if (utf) {
                try {
                    filename = decodeURIComponent(utf[1]);
                } catch {}
            }
            let blob;
            try {
                blob = await response.blob();
            } catch (cause) {
                throw networkError('Не удалось прочитать вложение', cause);
            }
            if (!blob.size) throw makeError('Сервер вернул пустой файл');
            const result = { blob, name: filename, chatId, savedAt: Date.now() };
            try {
                await this.put(`file:${id}`, result);
            } catch (error) {
                result.notSaved = true;
                attachmentError('Не удалось сохранить файл для офлайн', error, { id, chatId });
            }
            return result;
        } catch (error) {
            if (!error.network) {
                if ([403, 404].includes(error.statusCode)) await this.remove([`file:${id}`]).catch(() => {});
                throw error;
            }
            const cached = await this.cachedFile(id);
            if (!cached || Number(cached.chatId) !== chatId || !(cached.blob instanceof Blob)) {
                throw makeError('Этот файл ещё не сохранён в браузере');
            }
            return cached;
        }
    }
}

export default class OfflineChat extends ChatView {
    constructor(context) {
        super();
        this.local = new ChatLocal(context);
        this.context = { ...context, api: (action, data = {}) => this.local.api(action, data) };
        this.panel = context.panel;
        this.currentUserId = Number(context.bootstrap.user?.id || 0);
        this.generalChatId = 0;
        this.currentChat = null;
        this.chats = [];
        this.availableReactions = ['👍', '❤️', '🔥', '🙏', '👀', '🤮', '💩'];
        this.cursors = {};
        this.seenIds = {};
        this.unread = {};
        this.aiModes = new Map();
        this.aiModeVersions = new Map();
        this.legacyAiEnabled = false;
        this.destroyed = false;
        this.initialized = false;
        this.initRunning = false;
        this.loading = false;
        this.viewVersion = 0;
        this.switchRequest = 0;
        this.pollingVersion = null;
        this.statusRunning = false;
        this.sendRunning = false;
        this.aiRunning = false;
        this.uploadRunning = false;
        this.queueSaving = false;
        this.colorSaving = false;
        this.outbox = [];
        this.messages = new Map();
        this.pendingNodes = new Map();
        this.deletedIds = new Set();
        this.reactionStates = new Map();
        this.reactionRequests = new Set();
        this.reactionPickerId = null;
        this.reactionPickerElement = null;
        this.pickerFrame = null;
        this.replyTo = null;
        this.drafts = new Map();
        this.jumpVersion = 0;
        this.deleteArmed = null;
        this.editing = null;
        this.modal = null;
        this.modalClose = null;
        this.foldFrame = null;
        this.searchVersion = 0;
        this.searchRunVersion = 0;
        this.searchIndex = new Map();
        this.searchState = null;
        this.pins = [];
        this.selectedPinId = null;
        this.pinFrame = null;
        this.pinDialogState = null;
        this.pinBusy = new Set();
        this.scrollFrame = null;
        this.openingScroll = null;
        this.uploadPreviewUrls = new Set();
        this.objectUrls = new Set();
        this.storagePrefix = `erp-chat-ui:${new URL('./', location.href).pathname}:${this.currentUserId}`;
        this.localReady = this.loadLocalState();
        this.render();
        this.bindEvents();
		this.tabMessageHeads = new Map();
		this.tabAlert = null;
        this.bindCoreEvents();
        void this.init();
    }

    bindCoreEvents() {
        this.inputElement.oninput = () => {
            this.resizeInput();
            clearTimeout(this.draftSaveTimer);
            this.draftSaveTimer = setTimeout(() => { void this.saveLocalState(); }, 250);
        };
        this.aiElement.onchange = () => { void this.setAiMode(this.aiElement.value); };
        this.filesElement.onchange = () => {
            const files = [...this.filesElement.files];
            this.filesElement.value = '';
            if (files.length) void this.uploadFiles(files);
        };
		this.bindPageFileDrop();
		this.onChatTabVisibility = () => {
    if (!document.hidden) this.stopTabAlert();
};
document.addEventListener('visibilitychange', this.onChatTabVisibility);
        this.onPageHide = () => {
			this.stopTabAlert();
this.hideFileDropHint();
            this.captureDraft();
            void this.persistState().catch(error => console.error('Chat pagehide state save failed', error));
        };
        window.addEventListener('pagehide', this.onPageHide);
        if (window.ResizeObserver) {
            this.openingObserver = new ResizeObserver(() => this.finishOpeningScroll());
            this.openingObserver.observe(this.windowElement);
        }
    }

startTabAlert() {
    if (!document.hidden || this.destroyed || this.destroying || this.tabAlert) return;

    const alert = this.tabAlert = {
        originalTitle: document.title,
        noticeTitle: '💬 Новое сообщение',
        timer: null
    };

    document.title = alert.noticeTitle;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    alert.timer = setInterval(() => {
        if (!document.hidden || this.destroyed || this.destroying) {
            this.stopTabAlert();
            return;
        }

        document.title = document.title === alert.noticeTitle
            ? alert.originalTitle
            : alert.noticeTitle;
    }, 1200);
}

stopTabAlert() {
    const alert = this.tabAlert;
    if (!alert) return;

    clearInterval(alert.timer);
    if (document.title === alert.noticeTitle) document.title = alert.originalTitle;
    this.tabAlert = null;
}

async checkTabMessages(chats, seed = false) {
    for (const chat of chats) {
        if (this.destroyed || this.destroying) return;

        const chatId = Number(chat.chat);
        const head = Number(chat.last_message_id || 0);
        const previous = this.tabMessageHeads.get(chatId);

        // История при входе или при первом появлении чата не считается новой.
        if (seed || previous === undefined || !document.hidden) {
            this.tabMessageHeads.set(chatId, Math.max(previous ?? 0, head));
            continue;
        }

        const lastId = Math.max(previous, Number(this.seenIds[String(chatId)] || 0));
        if (head <= lastId) continue;

        try {
            const result = await this.context.api('poll', { chat: chatId, lastId });
            if (this.destroyed || this.destroying) return;
            if (result.offlineCached) continue;

            const seen = Math.max(lastId, Number(this.seenIds[String(chatId)] || 0));
            const hasIncoming = (result.messages || []).some(message =>
                VISIBLE_TYPES.has(message?.type) &&
                Number(message.id) > seen &&
                message.own !== true &&
                Number(message.user_id) !== this.currentUserId &&
                !this.isPinMessage(message)
            );

            const next = Math.max(lastId, Number(result.last_message_id) || 0);
            // Если на первой странице только служебные события, продолжим
            // со следующей страницы при очередной проверке status.
            this.tabMessageHeads.set(chatId, hasIncoming ? Math.max(head, next) : next);
            if (hasIncoming) this.startTabAlert();
        } catch (error) {
            // Не двигаем курсор: следующая проверка повторит запрос.
            console.debug('Chat notification check failed', error);
        }
    }
}
hideFileDropHint() {
    clearTimeout(this.fileDropTimer);
    if (this.fileDropHint) this.fileDropHint.hidden = true;
}

bindPageFileDrop() {
    this.fileDropEvents = new AbortController();
    const { signal } = this.fileDropEvents;
    const desktop = matchMedia('(min-width: 601px) and (any-pointer: fine)');
    const isFileDrag = event =>
        Array.from(event.dataTransfer?.types || []).includes('Files');

    const canDrop = () =>
        !this.destroyed && !this.destroying &&
        !this.attachElement.disabled && !this.modal &&
        !this.lightboxElement.classList.contains('open');

    const hint = this.fileDropHint = document.createElement('div');
    hint.className = 'chat-page-file-drop';
    hint.textContent = 'Отпустите файлы, чтобы прикрепить их к текущему чату';
    hint.setAttribute('aria-hidden', 'true');
    hint.hidden = true;
    document.body.append(hint);

    const onDragOver = event => {
        if (!desktop.matches || !isFileDrag(event)) return;

        // Не даём браузеру открыть файл вместо страницы.
        event.preventDefault();
        const allowed = canDrop();
        event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';

        if (!allowed) return this.hideFileDropHint();
        hint.hidden = false;
        // Сброс и при уходе за пределы окна, где drop не произойдёт.
        clearTimeout(this.fileDropTimer);
        this.fileDropTimer = setTimeout(() => this.hideFileDropHint(), 650);
    };

    window.addEventListener('dragenter', onDragOver, { capture: true, signal });
    window.addEventListener('dragover', onDragOver, { capture: true, signal });
    window.addEventListener('drop', event => {
        this.hideFileDropHint();
        if (!desktop.matches || (!isFileDrag(event) && !event.dataTransfer?.files.length)) return;

        event.preventDefault();
        const files = Array.from(event.dataTransfer.files);
        if (files.length && canDrop()) void this.uploadFiles(files);
    }, { capture: true, signal });

    window.addEventListener('dragend', () => this.hideFileDropHint(), { signal });
    window.addEventListener('blur', () => this.hideFileDropHint(), { signal });
}
    getStorage(name) {
        try {
            return localStorage.getItem(`${this.storagePrefix}:${name}`);
        } catch {
            return null;
        }
    }

    setStorage(name, value) {
        try {
            localStorage.setItem(`${this.storagePrefix}:${name}`, value);
        } catch {}
    }

    async loadLocalState() {
        try {
            const state = await this.local.get('ui-state');
            if (!state || this.destroyed) return;
            this.outbox = Array.isArray(state.outbox) ? state.outbox.filter(item => (
                item && typeof item.clientId === 'string' && typeof item.text === 'string'
                && Number.isSafeInteger(Number(item.chat)) && Number(item.chat) >= 0
            )).map(item => ({
                ...item,
                chat: Number(item.chat),
                createdAt: Number(item.createdAt) || Date.now(),
                phase: ['send', 'ai', 'failed'].includes(item.phase) ? item.phase : 'send',
                mode: asMode(item.mode ?? (item.ai ? 'summary' : 'off')),
                attempts: Number(item.attempts || 0),
                nextAttempt: Number(item.nextAttempt || 0)
            })) : [];
            this.seenIds = state.seenIds && typeof state.seenIds === 'object' && !Array.isArray(state.seenIds) ? state.seenIds : {};
            this.drafts = new Map(Array.isArray(state.drafts) ? state.drafts.filter(entry => Array.isArray(entry) && entry.length === 2) : []);
            if (Array.isArray(state.aiModes)) {
                for (const entry of state.aiModes) {
                    if (!Array.isArray(entry) || entry.length !== 2) continue;
                    const [chat, mode] = entry;
                    if (Number.isSafeInteger(chat) && chat > 0 && ['post', 'summary', 'image'].includes(mode)) {
                        this.aiModes.set(chat, mode);
                    }
                }
            } else {
                this.legacyAiEnabled = state.botActive === true;
            }
        } catch (error) {
            console.error('Chat local database failed', error);
        }
    }

    captureDraft() {
        if (this.currentChat === null || !this.inputElement || this.queueSaving) return;
        this.drafts.set(this.currentChat, {
            text: this.inputElement.value,
            reply: this.replyTo ? { ...this.replyTo } : null
        });
    }

    persistState() {
        const snapshot = structuredClone({
            outbox: this.outbox,
            seenIds: this.seenIds,
            drafts: [...this.drafts],
            aiModes: [...this.aiModes],
            savedAt: Date.now()
        });
        return this.local.serialize('ui-state', () => this.local.put('ui-state', snapshot));
    }

    saveLocalState() {
        this.captureDraft();
        return this.persistState().catch(error => {
            console.error('Chat state save failed', error);
            this.notify('Не удалось сохранить состояние чата в браузере. Не закрывайте вкладку.');
        });
    }

    async init() {
        await this.localReady;
        if (this.initRunning || this.destroyed) return;
        this.initRunning = true;
        try {
            const response = await this.context.api('init');
            if (this.destroyed) return;
            this.currentUserId = Number(response.currentUserId || this.currentUserId);
            this.generalChatId = Number(response.generalChatId ?? 0);
            if (Array.isArray(response.availableReactions) && response.availableReactions.length) {
                this.availableReactions = [...new Set(response.availableReactions.filter(value => typeof value === 'string' && value))];
            }
            this.chats = response.chats || [];
			if (!response.offlineCached) await this.checkTabMessages(this.chats, true);
            this.initialized = true;
            this.updateUnread();
            const rawUrl = this.context.getParam('chat');
            const rawMessage = this.context.getParam('message');
            const rawStored = this.getStorage('currentChat');
            const available = id => id !== null && this.chats.some(chat => Number(chat.chat) === id);
            const urlChat = rawUrl == null || rawUrl === '' ? null : Number(rawUrl);
            const storedChat = rawStored === null ? null : Number(rawStored);
            const target = available(urlChat) ? urlChat : available(storedChat) ? storedChat : Number(this.chats[0]?.chat ?? this.generalChatId);
            if (this.legacyAiEnabled) {
                const legacyChat = target !== this.generalChatId ? target : Number(this.chats.find(chat => Number(chat.chat) !== this.generalChatId)?.chat);
                if (Number.isSafeInteger(legacyChat) && legacyChat > 0) this.aiModes.set(legacyChat, 'summary');
                this.legacyAiEnabled = false;
            }
            const opened = this.chats.length ? await this.switchChat(target, true) : (this.clearCurrentChat(), false);
            if (this.destroyed) return;
            this.renderTabs();
            this.updateControls();
            this.startTimers();
            this.processOutbox();
            const id = Number(rawMessage);
            if (opened && target === urlChat && Number.isSafeInteger(id) && id > 0) {
                this.finishOpeningScroll();
                void this.jumpToMessage(target, id);
            }
        } catch (error) {
            if (this.destroyed) return;
            this.setConnection(false);
            this.windowElement.innerHTML = `<div class="chat-error">${escapeHtml(error.message || 'Ошибка загрузки')}<br>Повторное подключение выполняется автоматически.</div>`;
            this.startTimers();
        } finally {
            this.initRunning = false;
        }
    }

    startTimers() {
        if (this.destroyed) return;
        const config = this.context.bootstrap.chat || {};
        for (const timer of [this.pollTimer, this.statusTimer, this.outboxTimer]) clearInterval(timer);
        this.pollTimer = setInterval(() => {
            if (document.hidden) return;
            if (!this.initialized) void this.init();
            else void this.pollCurrentChat();
        }, Math.max(1200, Number(config.pollIntervalMs) || 2500));
this.statusTimer = setInterval(() => {
    void this.refreshChatStatus();
}, Math.max(5000, Number(config.statusIntervalMs) || 10000));
        this.outboxTimer = setInterval(() => this.processOutbox(), 3000);
    }

    updateControls() {
        const unavailable = this.currentChat === null || this.loading;
        const general = this.currentChat === this.generalChatId;
        const composerBusy = unavailable || this.queueSaving || this.uploadRunning;
        this.sendElement.disabled = composerBusy;
        this.inputElement.disabled = composerBusy;
        this.attachElement.disabled = composerBusy || !navigator.onLine;
        this.replyCancelElement.disabled = composerBusy;
        this.colorElement.disabled = unavailable || this.colorSaving || !navigator.onLine;
        this.aiElement.disabled = unavailable || general || this.queueSaving || this.uploadRunning;
        this.aiElement.value = unavailable || general ? 'off' : this.getAiMode(this.currentChat);
        this.searchElement.disabled = !this.initialized;
        this.createElement.disabled = !this.initialized || !navigator.onLine;
        this.menuPinsElement.disabled = unavailable;
    }

    resizeInput() {
        const bottom = this.nearBottom();
        this.inputElement.style.height = 'auto';
        this.inputElement.style.height = `${Math.min(140, this.inputElement.scrollHeight)}px`;
        if (bottom) this.scrollToBottom();
    }

    setConnection(online) {
        if (this.destroyed) return;
        const connected = online === true && this.local.online === true && navigator.onLine;
        this.connectionElement.classList.toggle('online', connected);
        this.connectionElement.classList.toggle('offline', !connected);
        this.connectionElement.title = connected ? 'Соединение установлено' : 'Нет соединения';
        this.connectionElement.setAttribute('aria-label', this.connectionElement.title);
    }

    notify(message, error = true) {
        if (this.destroyed) return;
        clearTimeout(this.noticeTimer);
        this.noticeElement.textContent = String(message);
        this.noticeElement.classList.toggle('error', error);
        this.noticeElement.hidden = false;
        this.noticeTimer = setTimeout(() => {
            if (!this.destroyed) this.noticeElement.hidden = true;
        }, 6000);
    }

    updateUnread() {
        for (const chat of this.chats) {
            const key = String(chat.chat);
            if (Number(chat.chat) !== this.currentChat) {
                this.unread[key] = Number(chat.last_message_id || 0) > Number(this.seenIds[key] || 0) ? 1 : 0;
            }
        }
    }

    markSeen(chatId) {
        if (document.hidden || this.destroyed) return;
        const key = String(chatId);
        const seen = Math.max(Number(this.seenIds[key] || 0), Number(this.cursors[key] || 0));
        const changed = seen !== Number(this.seenIds[key] || 0) || !!this.unread[key];
        this.seenIds[key] = seen;
        this.unread[key] = 0;
        if (changed) {
            this.renderTabs();
            void this.saveLocalState();
        }
    }

    applyMeta(meta) {
        if (!meta || this.destroyed) return;
        const chat = this.chats.find(entry => Number(entry.chat) === Number(meta.chat));
        if (chat) Object.assign(chat, meta);
        this.renderTabs();
        if (Number(meta.chat) === this.currentChat && !this.colorSaving) this.colorElement.value = this.safeColor(meta.color);
    }

    clearCurrentChat() {
        this.currentChat = null;
        this.replyTo = null;
        this.editing = null;
        this.loading = false;
        this.viewVersion++;
        this.jumpVersion++;
        this.openingScroll = null;
        this.closeReactionPicker();
        this.clearDeleteArm();
        this.messages.clear();
        this.pendingNodes.clear();
        this.deletedIds.clear();
        this.reactionStates.clear();
        this.windowElement.replaceChildren();
        this.inputElement.value = '';
        this.pins = [];
        this.selectedPinId = null;
        this.renderPinnedBar();
        this.renderReplyComposer();
        this.updateControls();
    }

    async refreshChatStatus() {
        if (this.destroyed || !this.initialized || !navigator.onLine || this.statusRunning) return;
        this.statusRunning = true;
        try {
            const response = await this.context.api('status');
            if (this.destroyed) return;
            this.chats = response.chats || [];
            const allowed = new Set(this.chats.map(chat => Number(chat.chat)));
            for (const map of [this.searchIndex, this.drafts, this.aiModes, this.aiModeVersions]) {
                for (const id of map.keys()) if (!allowed.has(id)) map.delete(id);
            }
            this.updateUnread();
            this.renderTabs();
            const current = this.chats.find(chat => Number(chat.chat) === this.currentChat);
            if (!current && (this.currentChat !== null || this.chats.length)) {
                this.editing = null;
                this.modalClose?.();
                if (this.chats[0]) await this.switchChat(Number(this.chats[0].chat), true);
                else this.clearCurrentChat();
            } else if (current && !this.colorSaving) {
                this.colorElement.value = this.safeColor(current.color);
            }
            this.setConnection(!response.offlineCached);
            this.updateControls();
			if (!response.offlineCached) await this.checkTabMessages(response.chats || []);
        } catch {
            this.setConnection(false);
        } finally {
            this.statusRunning = false;
        }
    }

    async switchChat(chatId, force = false) {
        if (this.destroyed || !this.chats.some(chat => Number(chat.chat) === chatId)) return false;
        if (!force && this.currentChat === chatId && !this.loading) {
            this.scrollToBottom();
            return false;
        }
        if (this.queueSaving || this.uploadRunning || this.editing?.saving) {
            this.notify('Дождитесь завершения текущей операции');
            return false;
        }
        if (this.editing && !confirm('Отменить несохранённое редактирование?')) return false;
        const request = ++this.switchRequest;
        this.captureDraft();
        try {
            await this.persistState();
        } catch (error) {
            console.error('Chat draft save failed', error);
            this.notify('Не удалось сохранить черновик. Переключение чата отменено.');
            return false;
        }
        if (this.destroyed || request !== this.switchRequest || this.queueSaving || this.uploadRunning || this.editing?.saving) return false;
        if (!this.chats.some(chat => Number(chat.chat) === chatId)) return false;
        this.captureDraft();
        this.clearDeleteArm();
        this.closeReactionPicker();
        this.editing = null;
        this.currentChat = chatId;
        this.loading = true;
        this.jumpVersion++;
        const version = ++this.viewVersion;
        this.pollingVersion = null;
        this.openingScroll = null;
        this.messages.clear();
        this.pendingNodes.clear();
        this.deletedIds.clear();
        this.reactionStates.clear();
        this.pins = [];
        this.selectedPinId = null;
        this.renderPinnedBar();
        this.unread[String(chatId)] = 0;
        this.setStorage('currentChat', String(chatId));
        this.context.setParams({ chat: chatId, message: null });
        this.windowElement.innerHTML = '<div class="chat-loading">Загрузка...</div>';
        const draft = this.drafts.get(chatId);
        this.inputElement.value = draft?.text || '';
        this.replyTo = this.normalizeReply(draft?.reply);
        this.renderReplyComposer();
        this.resizeInput();
        this.colorElement.value = this.safeColor(this.chats.find(chat => Number(chat.chat) === chatId)?.color);
        this.renderTabs();
        this.updateControls();
        try {
            const response = await this.context.api('poll', { chat: chatId, lastId: 0 });
            const state = await this.local.get(`chat:${chatId}`).catch(() => null);
            if (this.destroyed || version !== this.viewVersion) return false;
            this.renderHistory(response.messages || []);
            for (const id of state?.deleted || []) this.applyMessage({ type: 'delete', body: String(id) });
            this.cursors[String(chatId)] = Number(response.last_message_id || 0);
            this.markSeen(chatId);
            this.applyMeta(response.chat);
            this.renderPendingMessages();
            this.renderReplyComposer();
            this.refreshPins();
            this.setConnection(!response.offlineCached);
            this.openingScroll = { view: version, jump: this.jumpVersion };
            this.finishOpeningScroll();
            return true;
        } catch (error) {
            if (this.destroyed || version !== this.viewVersion) return false;
            this.cursors[String(chatId)] = 0;
            this.windowElement.innerHTML = `<div class="chat-error">${escapeHtml(error.message || 'Ошибка загрузки')}</div>`;
            this.renderPendingMessages();
            this.setConnection(false);
            return false;
        } finally {
            if (!this.destroyed && version === this.viewVersion) {
                this.loading = false;
                this.updateControls();
            }
        }
    }

    nearBottom() {
        const node = this.windowElement;
        return node.scrollHeight - node.scrollTop - node.clientHeight < 100;
    }

    finishOpeningScroll() {
        const target = this.openingScroll;
        if (this.destroyed || !target) return;
        if (target.view !== this.viewVersion || target.jump !== this.jumpVersion) {
            this.openingScroll = null;
            return;
        }
        if (!this.windowElement.clientHeight) return;
        this.openingScroll = null;
        this.windowElement.scrollTop = this.windowElement.scrollHeight;
        this.scrollToBottom();
    }

    scrollToBottom() {
        if (this.destroyed) return;
        const view = this.viewVersion;
        const jump = this.jumpVersion;
        if (this.scrollFrame !== null) cancelAnimationFrame(this.scrollFrame);
        this.scrollFrame = requestAnimationFrame(() => {
            this.scrollFrame = null;
            if (!this.destroyed && view === this.viewVersion && jump === this.jumpVersion) {
                this.windowElement.scrollTop = this.windowElement.scrollHeight;
            }
        });
    }

    async pollCurrentChat() {
        if (this.destroyed || this.loading || !this.initialized || !navigator.onLine || this.currentChat === null) return;
        const version = this.viewVersion;
        if (this.pollingVersion === version) return;
        this.pollingVersion = version;
        const chatId = this.currentChat;
        const key = String(chatId);
        try {
            for (let page = 0; page < 5; page++) {
                const lastId = Number(this.cursors[key] || 0);
                const response = await this.context.api('poll', { chat: chatId, lastId });
                if (this.destroyed || version !== this.viewVersion) return;
                const bottom = this.nearBottom();
                const messages = response.messages || [];
                if (response.initial && !this.editing) {
                    this.renderHistory(messages);
                    this.renderPendingMessages();
                } else {
                    for (const message of messages) this.applyMessage(message);
                }
                this.cursors[key] = Number(response.last_message_id ?? lastId);
                this.markSeen(chatId);
                this.applyMeta(response.chat);
                this.setConnection(!response.offlineCached);
                this.updateControls();
                this.schedulePickerPosition();
                this.schedulePins();
                if (bottom && messages.some(message => !this.isPinMessage(message))) this.scrollToBottom();
                if (response.has_more !== true || this.cursors[key] <= lastId) break;
            }
        } catch {
            if (!this.destroyed && version === this.viewVersion) this.setConnection(false);
        } finally {
            if (this.pollingVersion === version) this.pollingVersion = null;
        }
    }

    async saveChatColor(color) {
        const chatId = this.currentChat;
        if (chatId === null || this.destroyed || this.colorSaving) return;
        this.colorSaving = true;
        this.updateControls();
        try {
            const response = await this.context.api('setChatColor', { chat: chatId, color });
            if (!this.destroyed) this.applyMeta(response.chat);
        } catch (error) {
            this.notify(error.message || 'Не удалось сохранить цвет');
        } finally {
            this.colorSaving = false;
            if (!this.destroyed) {
                this.colorElement.value = this.safeColor(this.chats.find(chat => Number(chat.chat) === this.currentChat)?.color);
                this.updateControls();
            }
        }
    }

    async leaveChat(chatId) {
        if (!chatId || chatId === this.generalChatId) return;
        if (this.queueSaving || this.uploadRunning || this.editing?.saving) return this.notify('Дождитесь завершения текущей операции');
        if (!confirm('Покинуть этот чат?')) return;
        if (this.outbox.some(item => item.chat === chatId)) {
            return this.notify('Дождитесь отправки сообщений или уберите неотправленные сообщения.');
        }
        try {
            await this.context.api('leaveChat', { chat: chatId });
            if (this.destroyed) return;
            this.chats = this.chats.filter(chat => Number(chat.chat) !== chatId);
            for (const map of [this.searchIndex, this.drafts, this.aiModes, this.aiModeVersions]) map.delete(chatId);
            delete this.cursors[String(chatId)];
            delete this.seenIds[String(chatId)];
            delete this.unread[String(chatId)];
            if (this.currentChat === chatId) {
                this.clearCurrentChat();
                const next = this.chats.find(chat => Number(chat.chat) === this.generalChatId) || this.chats[0];
                if (next) await this.switchChat(Number(next.chat), true);
            }
            this.renderTabs();
            void this.saveLocalState();
        } catch (error) {
            this.notify(error.message || 'Не удалось покинуть чат');
        }
    }

    getAiMode(chatId) {
        if (chatId === null || chatId === this.generalChatId) return 'off';
        return asMode(this.aiModes.get(chatId));
    }

    aiSelection(chatId) {
        return { mode: this.getAiMode(chatId), version: this.aiModeVersions.get(chatId) || 0 };
    }

    writeAiMode(chatId, mode) {
        if (mode === 'off') this.aiModes.delete(chatId);
        else this.aiModes.set(chatId, mode);
        this.aiModeVersions.set(chatId, (this.aiModeVersions.get(chatId) || 0) + 1);
    }

    consumeAiMode(chatId, selection) {
        if (selection.mode === 'off') return false;
        const current = this.aiSelection(chatId);
        if (current.mode !== selection.mode || current.version !== selection.version) return false;
        this.writeAiMode(chatId, 'off');
        return true;
    }

    makeQueueItem(chat, text, mode, phase = 'send', sourceClientId = null) {
        return {
            clientId: createId(),
            sourceClientId,
            chat,
            text,
            mode,
            phase,
            createdAt: Date.now(),
            attempts: 0,
            nextAttempt: 0
        };
    }

    async setAiMode(value) {
        const chatId = this.currentChat;
        if (this.destroyed || this.loading || this.queueSaving || this.uploadRunning || chatId === null || chatId === this.generalChatId) {
            this.updateControls();
            return;
        }
        const mode = asMode(value);
        const previous = this.getAiMode(chatId);
        const item = mode === 'dialog' ? this.makeQueueItem(chatId, '', mode, 'ai') : null;
        this.queueSaving = true;
        this.writeAiMode(chatId, item ? 'off' : mode);
        if (item) this.outbox.push(item);
        this.updateControls();
        try {
            await this.persistState();
            if (item && !this.destroyed) {
                this.notify(navigator.onLine ? 'Запрос по всему диалогу поставлен в очередь.' : 'Запрос по диалогу будет отправлен после подключения.', false);
            }
        } catch (error) {
            if (item) this.outbox = this.outbox.filter(entry => entry !== item);
            this.writeAiMode(chatId, previous);
            console.error('Chat AI mode save failed', error);
            this.notify('Не удалось сохранить режим ИИ.');
        } finally {
            this.queueSaving = false;
            if (!this.destroyed) {
                this.updateControls();
                this.processOutbox();
            }
        }
    }

    isReservedText(text) {
        return !!this.parsePin(text) || /^\s*<meta\s+name="chat-album"\b/i.test(String(text || ''));
    }

    async sendMessage() {
        if (this.queueSaving || this.uploadRunning || this.loading || this.destroyed) return;
        const chatId = this.currentChat;
        const rawText = this.inputElement.value;
        if (chatId === null || !rawText.trim()) return;
        if (this.isReservedText(rawText)) return this.notify('Этот метатег зарезервирован для служебных сообщений.');
        const text = this.composeReply(rawText, this.replyTo);
        if ([...text].length > TEXT_LIMIT) return this.notify('Сообщение слишком длинное');
        const selection = this.aiSelection(chatId);
        const item = this.makeQueueItem(chatId, text, selection.mode);
        const draft = { text: rawText, reply: this.replyTo ? { ...this.replyTo } : null };
        clearTimeout(this.draftSaveTimer);
        this.queueSaving = true;
        this.updateControls();
        this.outbox.push(item);
        this.drafts.delete(chatId);
        const consumed = this.consumeAiMode(chatId, selection);
        try {
            await this.persistState();
            if (this.destroyed) return;
            this.inputElement.value = '';
            this.replyTo = null;
            this.renderReplyComposer();
            this.resizeInput();
            this.renderPendingMessages();
            this.scrollToBottom();
        } catch (error) {
            this.outbox = this.outbox.filter(entry => entry !== item);
            this.drafts.set(chatId, draft);
            if (consumed) this.writeAiMode(chatId, selection.mode);
            console.error('Chat queue save failed', error);
            this.notify('Сообщение не сохранено в локальную очередь. Текст оставлен в поле ввода.');
        } finally {
            this.queueSaving = false;
            if (!this.destroyed) {
                this.updateControls();
                this.inputElement.focus({ preventScroll: true });
                this.processOutbox();
            }
        }
    }

    processOutbox() {
        if (this.destroyed || this.queueSaving || !navigator.onLine || !this.initialized) return;
        void this.processSendQueue();
        void this.processAiQueue();
    }

    errorStatus(error) {
        return Number(error?.statusCode || error?.status || error?.response?.status || 0);
    }

    isPermanentError(error) {
        const status = this.errorStatus(error);
        return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
    }

    scheduleRetry(item) {
        item.attempts = Number(item.attempts || 0) + 1;
        item.nextAttempt = Date.now() + Math.min(60000, 2000 * (2 ** Math.min(item.attempts, 5)));
    }

    removeOutboxItem(item, persist = true) {
        const index = this.outbox.findIndex(entry => entry.clientId === item.clientId);
        if (index >= 0) this.outbox.splice(index, 1);
        if (!this.destroyed) this.removePendingNode(item.clientId);
        if (persist) void this.saveLocalState();
    }

    async processSendQueue() {
        if (this.sendRunning || !this.outbox.some(item => item.phase === 'send')) return;
        this.sendRunning = true;
        try {
            while (!this.destroyed && !this.queueSaving && navigator.onLine) {
                const item = this.outbox.find(entry => entry.phase === 'send' && Number(entry.nextAttempt || 0) <= Date.now());
                if (!item) break;
                try {
                    const response = await this.context.api('send', { chat: item.chat, text: item.text, clientId: item.clientId });
                    if (response.message && asMode(item.mode) !== 'off') {
                        Object.assign(item, { phase: 'ai', sourceClientId: item.clientId, attempts: 0, nextAttempt: 0 });
                    } else {
                        this.removeOutboxItem(item, false);
                    }
                    if (!this.destroyed && response.message) this.indexEvent(item.chat, response.message);
                    if (!this.destroyed && this.currentChat === item.chat && !this.loading) {
                        this.removePendingNode(item.clientId);
                        if (response.message) this.applyMessage(response.message);
                        if (this.nearBottom()) this.scrollToBottom();
                    }
                    await this.saveLocalState();
                    if (!this.destroyed) {
                        this.applyMeta(response.chat);
                        this.setConnection(true);
                        if (item.phase === 'ai') void this.processAiQueue();
                    }
                } catch (error) {
                    if (this.errorStatus(error) === 401) {
                        item.nextAttempt = Date.now() + 60000;
                        await this.saveLocalState();
                        this.notify('Для отправки очереди требуется повторный вход. Сообщения сохранены в браузере.');
                        break;
                    }
                    if (this.isPermanentError(error) || Number(item.attempts || 0) >= 7) item.phase = 'failed';
                    else this.scheduleRetry(item);
                    await this.saveLocalState();
                    if (!this.destroyed) {
                        this.renderPendingMessages();
                        this.notify(error.message || 'Ошибка отправки');
                    }
                    break;
                }
            }
        } finally {
            this.sendRunning = false;
            if (!this.destroyed) void this.pollCurrentChat();
        }
    }

    async processAiQueue() {
        if (this.aiRunning || !this.outbox.some(item => item.phase === 'ai')) return;
        this.aiRunning = true;
        try {
            while (!this.destroyed && !this.queueSaving && navigator.onLine) {
                const item = this.outbox.find(entry => entry.phase === 'ai' && Number(entry.nextAttempt || 0) <= Date.now());
                if (!item) break;
                const mode = asMode(item.mode);
                if (mode === 'off' || item.chat === this.generalChatId) {
                    this.removeOutboxItem(item, false);
                    await this.saveLocalState();
                    continue;
                }
                try {
                    const data = { chat: item.chat, mode, requestId: item.clientId };
                    if (mode !== 'dialog') data.sourceClientId = item.sourceClientId || item.clientId;
                    const response = await this.context.api('askAi', data);
                    if (response.processing) {
                        item.nextAttempt = Date.now() + 10000;
                        await this.saveLocalState();
                        continue;
                    }
                    this.removeOutboxItem(item, false);
                    await this.saveLocalState();
                    if (!this.destroyed) void this.pollCurrentChat();
                } catch (error) {
                    if (this.errorStatus(error) === 401) {
                        item.nextAttempt = Date.now() + 60000;
                    } else {
                        this.scheduleRetry(item);
                        if (this.isPermanentError(error) || Number(item.attempts) >= 3) {
                            this.removeOutboxItem(item, false);
                            this.notify(error.message || 'Не удалось получить ответ ИИ.');
                        }
                    }
                    await this.saveLocalState();
                }
            }
        } finally {
            this.aiRunning = false;
            if (!this.destroyed) void this.pollCurrentChat();
        }
    }

    async uploadFiles(files) {
        if (!files.length || this.currentChat === null || this.loading || this.destroyed || this.modal || this.uploadRunning || this.queueSaving) return;
        if (!navigator.onLine) return this.notify('Для загрузки вложений требуется сеть.');
        if (files.length > FILE_LIMIT) return this.notify(`За один раз можно загрузить до ${FILE_LIMIT} файлов.`);
        if (files.some(isImage)) {
            this.openUploadDialog(files);
            return;
        }
        const job = {
            chatId: this.currentChat,
            uploadId: createId(),
            files,
            caption: null,
            prepared: null
        };
        try {
            await this.submitUpload(job);
        } catch (error) {
            attachmentError('Не удалось загрузить файлы', error, { chatId: job.chatId, uploadId: job.uploadId });
            this.notify(error.message || 'Ошибка загрузки файлов');
        }
    }

    openUploadDialog(files) {
        const chatId = this.currentChat;
        const overlay = this.makeModal('Отправить изображения');
        const modal = overlay.querySelector('.chat-modal');
        modal.classList.add('chat-upload-modal');
        modal.insertAdjacentHTML('beforeend', `
            <div class="chat-upload-previews" aria-label="Выбранные изображения"></div>
            <div class="chat-upload-status" role="status"></div>
            <label class="chat-upload-caption">Подпись к изображениям<textarea rows="3" maxlength="${TEXT_LIMIT}" placeholder="Добавьте текст…"></textarea></label>
            <input class="chat-upload-picker" type="file" accept="image/*" multiple hidden>
            <div class="chat-modal-error" role="alert"></div>
            <div class="chat-modal-buttons">
                <button type="button" class="chat-upload-add">Добавить</button>
                <button type="button" class="chat-upload-cancel">Отмена</button>
                <button type="button" class="chat-create-confirm">Отправить</button>
            </div>`);
        const preview = modal.querySelector('.chat-upload-previews');
        const status = modal.querySelector('.chat-upload-status');
        const captionInput = modal.querySelector('textarea');
        const picker = modal.querySelector('.chat-upload-picker');
        const errorNode = modal.querySelector('.chat-modal-error');
        const add = modal.querySelector('.chat-upload-add');
        const cancel = modal.querySelector('.chat-upload-cancel');
        const send = modal.querySelector('.chat-create-confirm');
        const cross = modal.querySelector('.chat-search-close');
        const originalDraft = this.inputElement.value;
        const originalReply = this.normalizeReply(this.replyTo);
        const selected = [];
        const otherFiles = files.filter(file => !isImage(file));
        let busy = false;
        let job = null;
        captionInput.value = originalDraft;
        const release = item => {
            URL.revokeObjectURL(item.url);
            this.uploadPreviewUrls.delete(item.url);
        };
        const close = this.mountModal(overlay, () => !busy, () => {
            for (const item of selected) release(item);
        });

        const draw = () => {
            preview.replaceChildren();
            for (const [index, item] of selected.entries()) {
                const figure = document.createElement('figure');
                figure.className = 'chat-upload-preview';
                const image = document.createElement('img');
                image.src = item.url;
                image.alt = item.file.name;
                figure.title = item.file.name;
                const remove = this.actionButton('chat-upload-remove', '×', `Убрать ${item.file.name}`);
                remove.setAttribute('aria-label', remove.title);
                remove.disabled = busy || job !== null;
                remove.onclick = () => {
                    release(selected.splice(index, 1)[0]);
                    errorNode.textContent = '';
                    draw();
                    (preview.querySelector('.chat-upload-remove') || add).focus({ preventScroll: true });
                };
                figure.append(image, remove);
                preview.append(figure);
            }
            const count = selected.length;
            status.textContent = busy ? 'Отправка…' : `${count} из ${IMAGE_LIMIT} изображений${otherFiles.length ? ` · Других файлов: ${otherFiles.length}` : ''}`;
            add.disabled = busy || job !== null || count >= IMAGE_LIMIT || count + otherFiles.length >= FILE_LIMIT;
            send.disabled = busy || count + otherFiles.length === 0;
            cancel.disabled = cross.disabled = busy;
            captionInput.disabled = busy || job !== null || count === 0;
            send.textContent = job && !busy ? 'Повторить отправку' : 'Отправить';
        };

        const append = list => {
            let skipped = 0;
            for (const file of list) {
                if (!isImage(file) || selected.length >= IMAGE_LIMIT || selected.length + otherFiles.length >= FILE_LIMIT) {
                    skipped++;
                    continue;
                }
                const url = URL.createObjectURL(file);
                this.uploadPreviewUrls.add(url);
                selected.push({ file, url });
            }
            errorNode.textContent = skipped ? `Не добавлено файлов: ${skipped}. В один пост можно добавить до ${IMAGE_LIMIT} изображений.` : '';
            draw();
        };

        cross.onclick = cancel.onclick = close;
        add.onclick = () => picker.click();
        picker.onchange = () => {
            append([...picker.files]);
            picker.value = '';
            if (add.disabled) send.focus({ preventScroll: true });
        };
        captionInput.onkeydown = event => {
            if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                send.click();
            }
        };
        send.onclick = async () => {
            if (busy || this.destroyed) return;
            if (chatId !== this.currentChat || this.loading) {
                errorNode.textContent = 'Чат изменился. Откройте окно загрузки заново.';
                return;
            }
            if (!job) {
                const rawCaption = captionInput.value.trim();
                if (selected.length && this.isReservedText(rawCaption)) {
                    errorNode.textContent = 'Подпись содержит зарезервированный метатег.';
                    return;
                }
                const caption = selected.length ? this.composeReply(rawCaption, originalReply) : null;
                if (caption !== null && [...caption].length > TEXT_LIMIT - 512) {
                    errorNode.textContent = 'Подпись вместе с метаданными слишком длинная.';
                    return;
                }
                job = {
                    chatId,
                    uploadId: createId(),
                    files: [...selected.map(item => item.file), ...otherFiles],
                    albumCount: selected.length,
                    caption,
                    selection: caption === null ? null : this.aiSelection(chatId),
                    prepared: null
                };
            }
            busy = true;
            errorNode.textContent = '';
            draw();
            try {
                const response = await this.submitUpload(job);
                if (this.destroyed) return;
                if (response.albumMessage && this.currentChat === chatId) {
                    if (this.inputElement.value === originalDraft) this.inputElement.value = '';
                    if ((this.replyTo?.id ?? null) === (originalReply?.id ?? null)) this.replyTo = null;
                    this.renderReplyComposer();
                    this.resizeInput();
                    await this.saveLocalState();
                }
                busy = false;
                close();
            } catch (error) {
                if (this.destroyed) return;
                busy = false;
                if (this.isPermanentError(error) && this.errorStatus(error) !== 409) job = null;
                errorNode.textContent = error.message || 'Не удалось отправить вложения.';
                draw();
                send.focus({ preventScroll: true });
            }
        };
        append(files.filter(isImage));
        captionInput.focus({ preventScroll: true });
    }

    async submitUpload(job) {
        if (!navigator.onLine) throw networkError('Для загрузки вложений требуется сеть.');
        if (this.uploadRunning || this.queueSaving || this.destroyed) throw makeError('Дождитесь завершения текущей операции.');
        this.uploadRunning = true;
        this.updateControls();
        try {
            if (!job.prepared) {
                job.prepared = [];
                try {
                    for (const file of job.files) job.prepared.push(await this.prepareFile(file));
                } catch (error) {
                    job.prepared = null;
                    throw error;
                }
            }
            if (this.destroyed) throw makeError('Окно чата закрыто.');
            const form = new FormData();
            form.append('module', 'chat');
            form.append('action', 'upload');
            form.append('chat', String(job.chatId));
            form.append('uploadId', job.uploadId);
            if (job.caption !== null) {
                form.append('albumCaption', job.caption);
                form.append('albumCount', String(job.albumCount));
            }
            for (const file of job.prepared) form.append('files[]', file, file.name);
            const result = await this.local.request('upload', form);
            const messages = (result.files || []).map(file => file.message).filter(Boolean);
            if (!(result.files || []).length) throw makeError('Сервер не подтвердил загрузку файлов.');
            if (result.albumMessage) messages.push(result.albumMessage);
            await this.local.cacheEvents(job.chatId, messages);
            if (this.destroyed) return result;
            for (const message of messages) this.indexEvent(job.chatId, message);
            if (this.currentChat === job.chatId && !this.loading) {
                for (const message of messages) this.applyMessage(message);
                this.scrollToBottom();
            }
            if (job.caption !== null && !result.albumMessage) {
                this.notify('Файлы сохранены, но сервер не подтвердил создание альбома. Подпись оставлена в поле ввода.');
            } else if (result.errors?.length) {
                this.notify(`Не загружено файлов: ${result.errors.length}.`);
            }
            if (result.albumMessage?.client_id && job.selection?.mode !== 'off' && job.selection) {
                const source = result.albumMessage.client_id;
                const existing = this.outbox.some(item => item.chat === job.chatId && item.sourceClientId === source && item.phase === 'ai');
                if (!existing && this.consumeAiMode(job.chatId, job.selection)) {
                    this.outbox.push(this.makeQueueItem(job.chatId, '', job.selection.mode, 'ai', source));
                    await this.saveLocalState();
                }
            }
            this.applyMeta(result.chat);
            this.setConnection(true);
            void this.pollCurrentChat();
            return result;
        } finally {
            this.uploadRunning = false;
            if (!this.destroyed) {
                this.updateControls();
                this.processOutbox();
            }
        }
    }

    async prepareFile(file) {
        if (!isImage(file) || /(?:^image\/gif$|\.gif$)/i.test(`${file.type || ''}${file.type ? ' ' : ''}${file.name}`) || !window.createImageBitmap) return file;
        let bitmap;
        try {
            bitmap = await createImageBitmap(file);
            const scale = Math.min(1, 1280 / bitmap.width, 1280 / bitmap.height);
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            const context = canvas.getContext('2d');
            if (!context) return file;
            const type = file.type === 'image/png' ? 'image/png' : file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, type, .8));
            if (!blob || (scale === 1 && blob.size >= file.size && /^(image\/(?:jpeg|png|webp))$/i.test(file.type))) return file;
            const extension = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
            return new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'image'}.${extension}`, { type, lastModified: Date.now() });
        } catch (error) {
            attachmentError('Будет отправлено исходное изображение', error, { name: file.name });
            return file;
        } finally {
            bitmap?.close();
        }
    }

    rememberObjectUrl(blob) {
        const url = URL.createObjectURL(blob);
        this.objectUrls.add(url);
        return url;
    }

    async destroy() {
        if (this.destroyed || this.destroying) return;
        this.destroying = true;
		document.removeEventListener('visibilitychange', this.onChatTabVisibility);
this.stopTabAlert();
this.fileDropEvents?.abort();
this.hideFileDropHint();
this.fileDropHint?.remove();
        this.switchRequest++;
        clearTimeout(this.draftSaveTimer);
        window.removeEventListener('pagehide', this.onPageHide);
        await this.localReady;
        this.captureDraft();
        const saving = this.persistState();
        this.openingObserver?.disconnect();
        if (this.scrollFrame !== null) cancelAnimationFrame(this.scrollFrame);
        super.destroy();
        for (const url of this.uploadPreviewUrls) URL.revokeObjectURL(url);
        for (const url of this.objectUrls) URL.revokeObjectURL(url);
        this.uploadPreviewUrls.clear();
        this.objectUrls.clear();
        await saving.catch(error => console.error('Chat final state save failed', error));
    }
}