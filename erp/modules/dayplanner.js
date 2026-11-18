import {
    createId,
} from '../assets/app.js';

export default class Dayplanner {
    constructor(context) {
        this.context = context;
        this.panel = context.panel;
        this.destroyed = false;

        this.userId = Number(
            context.bootstrap?.user?.id || 0
        );

        this.today = '';
        this.selectedDate = '';
        this.dates = [];
        this.items = [];
        this.editing = false;
        this.dirty = false;
        this.saving = false;
        this.loading = false;
        this.syncing = false;
        this.loadSequence = 0;
        this.statusTimer = null;
        this.dragState = null;
        this.suppressClick = false;

        this.storagePrefix =
            `erp.dayplanner.${this.userId}`;

        this.onOnline = this.handleOnline.bind(this);
        this.onBeforeUnload =
            this.handleBeforeUnload.bind(this);

        this.render();
        this.bindEvents();
        this.init();
    }

    render() {
        this.panel.innerHTML = `
            <section class="erp-dayplanner">
                <header class="dayplanner-toolbar">
                    <label class="dayplanner-date-field">
                        <span>Дата</span>
                        <select
                            class="dayplanner-date"
                            aria-label="Дата списка"
                        ></select>
                    </label>

                    <div
                        class="dayplanner-sync-status"
                        role="status"
                        aria-live="polite"
                    ></div>
                </header>

                <main class="dayplanner-content">
                    <div class="dayplanner-loading loading">
                        Загрузка…
                    </div>

                    <div
                        class="dayplanner-error error-box"
                        hidden
                    ></div>

                    <div
                        class="dayplanner-view"
                        hidden
                    >
                        <div class="dayplanner-list"></div>

                        <div
                            class="dayplanner-empty empty-box"
                            hidden
                        >
                            На эту дату задач нет.
                        </div>
                    </div>

                    <div
                        class="dayplanner-editor"
                        hidden
                    >
                        <label class="dayplanner-editor-label">
                            <span>
                                Одна задача на строку. Для выполненной
                                задачи оставьте галочку в конце строки.
                            </span>

                            <textarea
                                class="dayplanner-textarea"
                                maxlength="100099"
                                rows="12"
                                spellcheck="true"
                                placeholder="Записать мысли и задачи…"
                            ></textarea>
                        </label>

                        <div
                            class="dayplanner-draft-note"
                            hidden
                        >
                            Восстановлен локальный черновик.
                        </div>
                    </div>
                </main>

                <footer class="dayplanner-footer">
                    <button
                        class="primary-button dayplanner-mode-button"
                        type="button"
                        disabled
                    >
                        Редактировать
                    </button>
                </footer>
            </section>
        `;

        this.root = this.panel.querySelector(
            '.erp-dayplanner'
        );
        this.dateSelect = this.root.querySelector(
            '.dayplanner-date'
        );
        this.statusElement = this.root.querySelector(
            '.dayplanner-sync-status'
        );
        this.loadingElement = this.root.querySelector(
            '.dayplanner-loading'
        );
        this.errorElement = this.root.querySelector(
            '.dayplanner-error'
        );
        this.viewElement = this.root.querySelector(
            '.dayplanner-view'
        );
        this.listElement = this.root.querySelector(
            '.dayplanner-list'
        );
        this.emptyElement = this.root.querySelector(
            '.dayplanner-empty'
        );
        this.editorElement = this.root.querySelector(
            '.dayplanner-editor'
        );
        this.textarea = this.root.querySelector(
            '.dayplanner-textarea'
        );
        this.draftNote = this.root.querySelector(
            '.dayplanner-draft-note'
        );
        this.modeButton = this.root.querySelector(
            '.dayplanner-mode-button'
        );
    }

    bindEvents() {
        this.dateSelect.addEventListener(
            'change',
            () => this.changeDate()
        );

        this.modeButton.addEventListener(
            'click',
            () => this.toggleMode()
        );

        this.textarea.addEventListener(
            'input',
            () => this.handleTextInput()
        );

        this.listElement.addEventListener(
            'click',
            (event) => this.handleListClick(event)
        );

        this.listElement.addEventListener(
            'pointerdown',
            (event) => this.startDrag(event)
        );

        this.listElement.addEventListener(
            'pointermove',
            (event) => this.moveDrag(event)
        );

        this.listElement.addEventListener(
            'pointerup',
            (event) => this.finishDrag(event)
        );

        this.listElement.addEventListener(
            'pointercancel',
            (event) => this.finishDrag(event)
        );

        window.addEventListener(
            'online',
            this.onOnline
        );

        window.addEventListener(
            'beforeunload',
            this.onBeforeUnload
        );
    }

    async init() {
        this.setLoading(true);
        this.clearError();

        try {
            const response = await this.context.api(
                'init',
                {}
            );

            if (this.destroyed) {
                return;
            }

            this.today = String(response.today || '');
            this.dates = Array.isArray(response.dates)
                ? response.dates.map(String)
                : [this.today];

            const requestedDate = String(
                this.context.getParam('date') || ''
            );

            this.selectedDate = this.dates.includes(
                requestedDate
            )
                ? requestedDate
                : this.today;

            this.renderDateOptions();
            this.context.setParams({
                date: this.selectedDate,
            });

            if (Number(response.carried || 0) > 0) {
                this.showStatus(
                    `Перенесено задач: ${response.carried}`,
                    'success'
                );
            }

            await this.loadDate(this.selectedDate);

            if (this.destroyed) {
                return;
            }

            await this.flushQueues();
        } catch (error) {
            if (!this.destroyed) {
                this.showError(error.message);
            }
        } finally {
            if (!this.destroyed) {
                this.setLoading(false);
            }
        }
    }

    async loadDate(date) {
        const sequence = ++this.loadSequence;

        this.setLoading(true);
        this.clearError();
        this.modeButton.disabled = true;

        try {
            const response = await this.context.api(
                'list',
                {
                    date,
                }
            );

            if (
                this.destroyed
                || sequence !== this.loadSequence
            ) {
                return;
            }

            this.items = Array.isArray(response.items)
                ? response.items
                : [];

            this.applyQueuedDoneStates();
            this.renderList();

            this.modeButton.disabled = false;
        } catch (error) {
            if (
                !this.destroyed
                && sequence === this.loadSequence
            ) {
                this.showError(error.message);
            }
        } finally {
            if (
                !this.destroyed
                && sequence === this.loadSequence
            ) {
                this.setLoading(false);
            }
        }
    }

    async changeDate() {
        const nextDate = this.dateSelect.value;

        if (nextDate === this.selectedDate) {
            return;
        }

        if (
            this.editing
            && this.dirty
            && !confirm(
                'Перейти к другой дате? Несохранённый текст останется в локальном черновике.'
            )
        ) {
            this.dateSelect.value = this.selectedDate;
            return;
        }

        this.editing = false;
        this.dirty = false;
        this.selectedDate = nextDate;
        this.updateModeVisibility();

        this.context.setParams({
            date: nextDate,
        });

        await this.loadDate(nextDate);
    }

    toggleMode() {
        if (this.saving || this.loading) {
            return;
        }

        if (this.editing) {
            this.save();
            return;
        }

        this.enterEditMode();
    }

    enterEditMode() {
        const generatedText = this.items
            .map((item) => (
                item.done
                    ? `${item.text} ✓`
                    : item.text
            ))
            .join('\n');

        const draft = this.readDraft(
            this.selectedDate
        );

        if (
            draft
            && typeof draft.text === 'string'
            && draft.text !== generatedText
        ) {
            this.textarea.value = draft.text;
            this.draftNote.hidden = false;
            this.dirty = true;
        } else {
            this.textarea.value = generatedText;
            this.draftNote.hidden = true;
            this.dirty = false;
        }

        this.editing = true;
        this.updateModeVisibility();

        requestAnimationFrame(() => {
            if (!this.destroyed) {
                this.textarea.focus();
            }
        });
    }

    handleTextInput() {
        this.dirty = true;
        this.draftNote.hidden = true;

        this.writeDraft(
            this.selectedDate,
            {
                text: this.textarea.value,
                payload: null,
            }
        );
    }

    parseEditorText() {
        const lines = this.textarea.value
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter((line) => line !== '');

        if (lines.length > 100) {
            throw new Error(
                'На один день можно сохранить не более 100 задач'
            );
        }

        return lines.map((line, index) => {
            const done = /(?:✓|✔|☑)\s*$/u.test(line);
            const text = line
                .replace(/\s*(?:✓|✔|☑)\s*$/u, '')
                .trim();

            if (!text) {
                throw new Error(
                    `Строка ${index + 1} не содержит текста`
                );
            }

            if ([...text].length > 1000) {
                throw new Error(
                    `Строка ${index + 1} длиннее 1000 символов`
                );
            }

            const existing = this.items[index] || null;

            return {
                id: Number(existing?.id || 0),
                clientId:
                    existing?.clientId || createId(),
                text,
                done: done ? 1 : 0,
            };
        });
    }

    async save() {
        if (this.saving) {
            return;
        }

        let items;

        try {
            const draft = this.readDraft(
                this.selectedDate
            );

            if (
                draft
                && draft.text === this.textarea.value
                && Array.isArray(draft.payload)
            ) {
                items = draft.payload;
            } else {
                items = this.parseEditorText();

                this.writeDraft(
                    this.selectedDate,
                    {
                        text: this.textarea.value,
                        payload: items,
                    }
                );
            }
        } catch (error) {
            this.showError(error.message);
            return;
        }

        this.saving = true;
        this.modeButton.disabled = true;
        this.modeButton.textContent = 'Сохранение…';
        this.clearError();

        try {
            const response = await this.context.api(
                'save',
                {
                    date: this.selectedDate,
                    items,
                }
            );

            if (this.destroyed) {
                return;
            }

            this.items = Array.isArray(response.items)
                ? response.items
                : [];

            if (Array.isArray(response.dates)) {
                this.dates = response.dates.map(String);
                this.renderDateOptions();
            }

            this.removeDraft(this.selectedDate);
            this.dirty = false;
            this.editing = false;
            this.renderList();
            this.updateModeVisibility();
            this.showStatus('Сохранено', 'success');
        } catch (error) {
            if (!this.destroyed) {
                this.showError(
                    `${error.message}. Текст сохранён локально как черновик.`
                );
            }
        } finally {
            if (!this.destroyed) {
                this.saving = false;
                this.modeButton.disabled = false;
                this.updateModeVisibility();
            }
        }
    }

    renderDateOptions() {
        this.dateSelect.replaceChildren();

        for (const date of this.dates) {
            const option = document.createElement('option');
            option.value = date;
            option.textContent = this.formatDate(date);

            if (date === this.today) {
                option.textContent += ' — сегодня';
            }

            option.selected = date === this.selectedDate;
            this.dateSelect.appendChild(option);
        }
    }

    renderList() {
        this.listElement.replaceChildren();

        for (const item of this.items) {
            const card = document.createElement('article');
            card.className = 'dayplanner-card';
            card.dataset.id = String(item.id);

            if (item.done) {
                card.classList.add(
                    'dayplanner-card-done'
                );
            }

            const dragButton = document.createElement(
                'button'
            );
            dragButton.type = 'button';
            dragButton.className =
                'dayplanner-drag-handle';
            dragButton.dataset.dragHandle = '1';
            dragButton.setAttribute(
                'aria-label',
                'Изменить порядок задачи'
            );
            dragButton.textContent = '⋮⋮';

            const text = document.createElement('span');
            text.className = 'dayplanner-card-text';
            text.textContent = item.text || '';

            const mark = document.createElement('span');
            mark.className = 'dayplanner-card-mark';
            mark.setAttribute('aria-hidden', 'true');
            mark.textContent = item.done ? '✓' : '';

            card.append(
                dragButton,
                text,
                mark
            );

            this.listElement.appendChild(card);
        }

        this.emptyElement.hidden =
            this.items.length !== 0;
    }

    async handleListClick(event) {
        if (
            this.editing
            || this.suppressClick
            || event.target.closest(
                '.dayplanner-drag-handle'
            )
        ) {
            return;
        }

        const card = event.target.closest(
            '.dayplanner-card'
        );

        if (!card) {
            return;
        }

        const id = Number(card.dataset.id || 0);
        const item = this.items.find(
            (entry) => Number(entry.id) === id
        );

        if (!item || id <= 0) {
            return;
        }

        const nextDone = item.done ? 0 : 1;
        item.done = nextDone ? 'pending' : null;

        this.enqueueDone(id, nextDone);
        this.renderList();
        await this.flushQueues();
    }

    startDrag(event) {
        const handle = event.target.closest(
            '.dayplanner-drag-handle'
        );

        if (
            !handle
            || this.editing
            || this.items.length < 2
        ) {
            return;
        }

        const card = handle.closest(
            '.dayplanner-card'
        );

        if (!card) {
            return;
        }

        event.preventDefault();

        handle.setPointerCapture?.(
            event.pointerId
        );

        this.dragState = {
            pointerId: event.pointerId,
            card,
            startY: event.clientY,
            moved: false,
        };

        card.classList.add(
            'dayplanner-card-dragging'
        );
    }

    moveDrag(event) {
        const state = this.dragState;

        if (
            !state
            || state.pointerId !== event.pointerId
        ) {
            return;
        }

        event.preventDefault();

        if (
            Math.abs(event.clientY - state.startY) > 4
        ) {
            state.moved = true;
        }

        const target = document
            .elementFromPoint(
                event.clientX,
                event.clientY
            )
            ?.closest('.dayplanner-card');

        if (
            !target
            || target === state.card
            || target.parentElement !== this.listElement
        ) {
            return;
        }

        const rectangle =
            target.getBoundingClientRect();

        if (
            event.clientY
            < rectangle.top + rectangle.height / 2
        ) {
            this.listElement.insertBefore(
                state.card,
                target
            );
        } else {
            this.listElement.insertBefore(
                state.card,
                target.nextSibling
            );
        }
    }

    async finishDrag(event) {
        const state = this.dragState;

        if (
            !state
            || state.pointerId !== event.pointerId
        ) {
            return;
        }

        state.card.classList.remove(
            'dayplanner-card-dragging'
        );

        this.dragState = null;

        if (!state.moved) {
            return;
        }

        this.suppressClick = true;

        setTimeout(() => {
            this.suppressClick = false;
        }, 0);

        const ids = Array.from(
            this.listElement.querySelectorAll(
                '.dayplanner-card'
            )
        ).map((card) => Number(card.dataset.id));

        const byId = new Map(
            this.items.map((item) => [
                Number(item.id),
                item,
            ])
        );

        this.items = ids
            .map((id) => byId.get(id))
            .filter(Boolean);

        this.enqueueReorder(
            this.selectedDate,
            ids
        );

        await this.flushQueues();
    }

    enqueueDone(id, done) {
        const queue = this.readJsonStorage(
            `${this.storagePrefix}.doneQueue`,
            {}
        );

        queue[String(id)] = {
            id,
            done,
        };

        const keys = Object.keys(queue);

        if (keys.length > 100) {
            delete queue[keys[0]];
        }

        this.writeJsonStorage(
            `${this.storagePrefix}.doneQueue`,
            queue
        );

        this.showStatus(
            'Изменение ожидает подтверждения',
            'pending'
        );
    }

    enqueueReorder(date, ids) {
        const queue = this.readJsonStorage(
            `${this.storagePrefix}.reorderQueue`,
            {}
        );

        queue[date] = {
            date,
            ids,
        };

        const dates = Object.keys(queue);

        if (dates.length > 20) {
            delete queue[dates[0]];
        }

        this.writeJsonStorage(
            `${this.storagePrefix}.reorderQueue`,
            queue
        );

        this.showStatus(
            'Порядок ожидает подтверждения',
            'pending'
        );
    }

    async flushQueues() {
        if (
            this.destroyed
            || this.syncing
            || !navigator.onLine
        ) {
            return;
        }

        this.syncing = true;

        try {
            let doneQueue = this.readJsonStorage(
                `${this.storagePrefix}.doneQueue`,
                {}
            );

            for (const key of Object.keys(doneQueue)) {
                if (this.destroyed) {
                    return;
                }

                const operation = doneQueue[key];
                const response = await this.context.api(
                    'setDone',
                    operation
                );

                if (this.destroyed) {
                    return;
                }

                doneQueue = this.readJsonStorage(
                    `${this.storagePrefix}.doneQueue`,
                    {}
                );

                const current = doneQueue[key];

                if (
                    current
                    && Number(current.done)
                        === Number(operation.done)
                ) {
                    delete doneQueue[key];

                    this.writeJsonStorage(
                        `${this.storagePrefix}.doneQueue`,
                        doneQueue
                    );
                }

                const item = this.items.find(
                    (entry) => Number(entry.id)
                        === Number(operation.id)
                );

                if (item) {
                    item.done = response.done || null;
                }
            }

            let reorderQueue = this.readJsonStorage(
                `${this.storagePrefix}.reorderQueue`,
                {}
            );

            for (
                const date
                of Object.keys(reorderQueue)
            ) {
                if (this.destroyed) {
                    return;
                }

                const operation = reorderQueue[date];

                await this.context.api(
                    'reorder',
                    operation
                );

                if (this.destroyed) {
                    return;
                }

                reorderQueue = this.readJsonStorage(
                    `${this.storagePrefix}.reorderQueue`,
                    {}
                );

                const current = reorderQueue[date];

                if (
                    current
                    && JSON.stringify(current.ids)
                        === JSON.stringify(operation.ids)
                ) {
                    delete reorderQueue[date];

                    this.writeJsonStorage(
                        `${this.storagePrefix}.reorderQueue`,
                        reorderQueue
                    );
                }
            }

            this.applyQueuedDoneStates();
            this.renderList();

            if (!this.hasPendingOperations()) {
                this.showStatus(
                    'Все изменения сохранены',
                    'success'
                );
            }
        } catch (error) {
            if (!this.destroyed) {
                this.showStatus(
                    'Нет связи. Изменения сохранены локально',
                    'pending'
                );
            }
        } finally {
            this.syncing = false;
        }
    }

    applyQueuedDoneStates() {
        const queue = this.readJsonStorage(
            `${this.storagePrefix}.doneQueue`,
            {}
        );

        for (const operation of Object.values(queue)) {
            const item = this.items.find(
                (entry) => Number(entry.id)
                    === Number(operation.id)
            );

            if (item) {
                item.done = Number(operation.done)
                    ? 'pending'
                    : null;
            }
        }
    }

    hasPendingOperations() {
        const doneQueue = this.readJsonStorage(
            `${this.storagePrefix}.doneQueue`,
            {}
        );
        const reorderQueue = this.readJsonStorage(
            `${this.storagePrefix}.reorderQueue`,
            {}
        );

        return (
            Object.keys(doneQueue).length > 0
            || Object.keys(reorderQueue).length > 0
        );
    }

    handleOnline() {
        this.flushQueues();
    }

    handleBeforeUnload(event) {
        if (!this.editing || !this.dirty) {
            return;
        }

        event.preventDefault();
        event.returnValue = '';
    }

    updateModeVisibility() {
        this.viewElement.hidden = this.editing;
        this.editorElement.hidden = !this.editing;

        if (this.saving) {
            this.modeButton.textContent = 'Сохранение…';
            return;
        }

        this.modeButton.textContent = this.editing
            ? 'Сохранить'
            : 'Редактировать';
    }

    setLoading(loading) {
        this.loading = loading;
        this.loadingElement.hidden = !loading;

        if (loading) {
            this.viewElement.hidden = true;
            this.editorElement.hidden = true;
        } else {
            this.updateModeVisibility();
        }
    }

    showError(message) {
        this.errorElement.textContent =
            message || 'Произошла ошибка';
        this.errorElement.hidden = false;
    }

    clearError() {
        this.errorElement.textContent = '';
        this.errorElement.hidden = true;
    }

    showStatus(message, type = '') {
        clearTimeout(this.statusTimer);

        this.statusElement.textContent = message;
        this.statusElement.dataset.type = type;

        if (type === 'success') {
            this.statusTimer = setTimeout(() => {
                if (!this.destroyed) {
                    this.statusElement.textContent = '';
                    this.statusElement.dataset.type = '';
                }
            }, 3500);
        }
    }

    formatDate(date) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(
            date
        );

        if (!match) {
            return date;
        }

        return `${match[3]}.${match[2]}.${match[1]}`;
    }

    draftStorageKey(date) {
        return `${this.storagePrefix}.draft.${date}`;
    }

    readDraft(date) {
        return this.readJsonStorage(
            this.draftStorageKey(date),
            null
        );
    }

    writeDraft(date, value) {
        try {
            localStorage.setItem(
                this.draftStorageKey(date),
                JSON.stringify(value)
            );
        } catch (error) {
            this.showStatus(
                'Не удалось сохранить локальный черновик',
                'pending'
            );
        }
    }

    removeDraft(date) {
        try {
            localStorage.removeItem(
                this.draftStorageKey(date)
            );
        } catch (error) {
            // Успешное серверное сохранение важнее очистки черновика.
        }
    }

    readJsonStorage(key, fallback) {
        try {
            const value = localStorage.getItem(key);

            if (value === null) {
                return fallback;
            }

            const parsed = JSON.parse(value);

            return parsed ?? fallback;
        } catch (error) {
            return fallback;
        }
    }

    writeJsonStorage(key, value) {
        try {
            localStorage.setItem(
                key,
                JSON.stringify(value)
            );
        } catch (error) {
            this.showStatus(
                'Локальная очередь переполнена',
                'pending'
            );
        }
    }

    destroy() {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        this.loadSequence++;

        clearTimeout(this.statusTimer);

        window.removeEventListener(
            'online',
            this.onOnline
        );

        window.removeEventListener(
            'beforeunload',
            this.onBeforeUnload
        );

        this.dragState = null;
        this.items = [];
        this.dates = [];

        this.panel.innerHTML = '';
    }
}