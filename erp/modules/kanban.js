export default class Kanban {
    constructor(context) {
        this.context = context;
        this.panel = context.panel;

        this.boards = [];
        this.board = null;
        this.columns = [];
        this.cards = [];
        this.users = [];

        this.currentCard = null;
        this.dragCardId = null;
        this.dragColumnId = null;
        this.loading = false;
        this.destroyed = false;

        this.cachePrefix = `erp-kanban-${context.bootstrap.user.id}`;
        this.lastBoardKey = `${this.cachePrefix}-last-board`;

        this.renderShell();
        this.createCardModal();
        this.bindShellEvents();
        this.restoreCachedBoard();
        this.initialize();
    }

    renderShell() {
        this.panel.innerHTML = `
            <section class="kanban-module">
                <div class="kanban-toolbar">
                    <select
                        id="kanban-board-select"
                        aria-label="Выбор доски"
                    ></select>

                    <button
                        id="kanban-board-add"
                        class="kanban-icon-button"
                        type="button"
                        title="Новая доска"
                    >＋</button>

                    <button
                        id="kanban-board-edit"
                        class="kanban-icon-button"
                        type="button"
                        title="Изменить доску"
                    >✎</button>

                    <button
                        id="kanban-board-delete"
                        class="kanban-icon-button kanban-danger-icon"
                        type="button"
                        title="Удалить доску"
                    >×</button>

                    <button
                        id="kanban-column-add"
                        class="kanban-add-column"
                        type="button"
                    >＋ Колонка</button>

                    <button
                        id="kanban-refresh"
                        class="kanban-icon-button"
                        type="button"
                        title="Обновить"
                    >↻</button>

                    <span
                        id="kanban-connection"
                        class="kanban-connection"
                    ></span>
                </div>

                <div
                    id="kanban-board"
                    class="kanban-board"
                ></div>

                <div
                    id="kanban-empty"
                    class="kanban-empty"
                    hidden
                >
                    <strong>Нет досок</strong>
                    <span>Создайте первую Kanban-доску.</span>
                    <button
                        id="kanban-empty-create"
                        class="primary-button"
                        type="button"
                    >Создать доску</button>
                </div>
            </section>
        `;

        this.boardElement = this.panel.querySelector('#kanban-board');
        this.boardSelect = this.panel.querySelector(
            '#kanban-board-select'
        );
        this.connectionElement = this.panel.querySelector(
            '#kanban-connection'
        );
        this.emptyElement = this.panel.querySelector('#kanban-empty');
    }

    createCardModal() {
        this.modal = document.createElement('div');
        this.modal.className = 'erp-modal kanban-card-modal';

        this.modal.innerHTML = `
            <div class="erp-modal-card">
                <header class="erp-modal-header">
                    <strong id="kanban-card-modal-title">
                        Карточка
                    </strong>

                    <button
                        class="erp-modal-close"
                        type="button"
                    >×</button>
                </header>

                <form
                    id="kanban-card-form"
                    class="erp-modal-body erp-form-grid"
                >
                    <label class="erp-field full">
                        Название
                        <input
                            name="title"
                            type="text"
                            maxlength="255"
                            required
                        >
                    </label>

                    <label class="erp-field">
                        Колонка
                        <select name="column_id"></select>
                    </label>

                    <label class="erp-field">
                        Приоритет
                        <select name="priority">
                            <option value="0">Обычный</option>
                            <option value="1">Низкий</option>
                            <option value="2">Важный</option>
                            <option value="3">Срочный</option>
                        </select>
                    </label>

                    <label class="erp-field">
                        Срок
                        <input
                            name="due_date"
                            type="date"
                        >
                    </label>

                    <label class="erp-field">
                        Исполнитель
                        <select name="assigned_user_id"></select>
                    </label>

                    <label class="erp-field full">
                        Описание
                        <textarea
                            name="description"
                            rows="7"
                        ></textarea>
                    </label>
                </form>

                <footer class="erp-modal-footer">
                    <button
                        id="kanban-card-delete"
                        class="danger-button"
                        type="button"
                    >Удалить</button>

                    <button
                        class="secondary-button kanban-card-cancel"
                        type="button"
                    >Отмена</button>

                    <button
                        id="kanban-card-save"
                        class="primary-button"
                        type="button"
                    >Сохранить</button>
                </footer>
            </div>
        `;

        document.body.appendChild(this.modal);

        this.cardForm = this.modal.querySelector('#kanban-card-form');
        this.cardSaveButton = this.modal.querySelector(
            '#kanban-card-save'
        );
        this.cardDeleteButton = this.modal.querySelector(
            '#kanban-card-delete'
        );

        this.modal.querySelector('.erp-modal-close').onclick = () => {
            this.closeCardModal();
        };

        this.modal.querySelector('.kanban-card-cancel').onclick = () => {
            this.closeCardModal();
        };

        this.cardSaveButton.onclick = () => this.saveCard();
        this.cardDeleteButton.onclick = () => this.deleteCard();

        this.modal.onclick = event => {
            if (event.target === this.modal) {
                this.closeCardModal();
            }
        };
    }

    bindShellEvents() {
        this.boardSelect.onchange = () => {
            const boardId = Number(this.boardSelect.value);

            if (boardId > 0) {
                this.loadBoard(boardId);
            }
        };

        this.panel.querySelector('#kanban-board-add').onclick = () => {
            this.createBoard();
        };

        this.panel.querySelector('#kanban-board-edit').onclick = () => {
            this.editBoard();
        };

        this.panel.querySelector('#kanban-board-delete').onclick = () => {
            this.deleteBoard();
        };

        this.panel.querySelector('#kanban-column-add').onclick = () => {
            this.createColumn();
        };

        this.panel.querySelector('#kanban-refresh').onclick = () => {
            if (this.board?.id) {
                this.loadBoard(Number(this.board.id));
            } else {
                this.loadBoards();
            }
        };

        this.panel.querySelector('#kanban-empty-create').onclick = () => {
            this.createBoard();
        };

        this.onlineHandler = () => {
            this.setConnection('online');
            this.loadBoards(false);
        };

        this.offlineHandler = () => {
            this.setConnection('offline');
        };

        window.addEventListener('online', this.onlineHandler);
        window.addEventListener('offline', this.offlineHandler);
    }

    async initialize() {
        this.setConnection(
            navigator.onLine ? 'loading' : 'offline'
        );

        await this.loadBoards();
    }

    async loadBoards(loadSelectedBoard = true) {
        if (this.loading || this.destroyed) {
            return;
        }

        this.loading = true;

        try {
            const response = await this.context.api('boards');

            this.boards = Array.isArray(response.boards)
                ? response.boards
                : [];

            this.renderBoardSelect();
            this.setConnection('online');

            if (!this.boards.length) {
                this.board = null;
                this.columns = [];
                this.cards = [];
                this.renderBoard();
                return;
            }

            if (!loadSelectedBoard && this.board?.id) {
                return;
            }

            const requestedId = Number(
                this.context.getParam('board')
            );

            const storedId = Number(
                localStorage.getItem(this.lastBoardKey)
            );

            const selectedId = [
                requestedId,
                Number(this.board?.id),
                storedId,
                Number(this.boards[0]?.id),
            ].find(id => {
                return id > 0 && this.boards.some(
                    board => Number(board.id) === Number(id)
                );
            });

            if (selectedId) {
                await this.loadBoard(selectedId);
            }
        } catch (error) {
            this.setConnection('offline', error.message);

            if (!this.board) {
                this.renderBoard();
            }
        } finally {
            this.loading = false;
        }
    }

    async loadBoard(boardId) {
        if (this.destroyed || boardId <= 0) {
            return;
        }

        this.setConnection('loading');

        try {
            const response = await this.context.api(
                'get_board',
                { board_id: boardId }
            );

            this.applyBoardResponse(response);
            this.saveCachedBoard();
            this.setConnection('online');
        } catch (error) {
            const restored = this.restoreCachedBoard(boardId);

            this.setConnection(
                restored ? 'offline' : 'error',
                error.message
            );

            if (!restored) {
                alert(error.message);
            }
        }
    }

    applyBoardResponse(response) {
        this.board = response.board || null;
        this.columns = Array.isArray(response.columns)
            ? response.columns
            : [];
        this.cards = Array.isArray(response.cards)
            ? response.cards
            : [];
        this.users = Array.isArray(response.users)
            ? response.users
            : [];

        if (this.board?.id) {
            const boardId = Number(this.board.id);

            localStorage.setItem(
                this.lastBoardKey,
                String(boardId)
            );

            this.context.setParams({
                board: boardId,
            });

            this.boardSelect.value = String(boardId);
        }

        this.renderBoard();
    }

    renderBoardSelect() {
        this.boardSelect.innerHTML = '';

        if (!this.boards.length) {
            const option = document.createElement('option');

            option.value = '';
            option.textContent = 'Нет досок';

            this.boardSelect.appendChild(option);
            this.boardSelect.disabled = true;
            return;
        }

        this.boardSelect.disabled = false;

        this.boards.forEach(board => {
            const option = document.createElement('option');

            option.value = String(board.id);
            option.textContent = board.name;

            this.boardSelect.appendChild(option);
        });

        if (this.board?.id) {
            this.boardSelect.value = String(this.board.id);
        }
    }

    renderBoard() {
        const hasBoard = Boolean(this.board?.id);

        this.emptyElement.hidden = hasBoard;
        this.boardElement.hidden = !hasBoard;

        this.panel.querySelector('#kanban-board-edit').disabled =
            !hasBoard;

        this.panel.querySelector('#kanban-board-delete').disabled =
            !hasBoard;

        this.panel.querySelector('#kanban-column-add').disabled =
            !hasBoard;

        if (!hasBoard) {
            this.boardElement.innerHTML = '';
            return;
        }

        this.columns.sort(
            (a, b) => Number(a.position) - Number(b.position)
                || Number(a.id) - Number(b.id)
        );

        this.boardElement.innerHTML = '';

        this.columns.forEach((column, columnIndex) => {
            const columnElement = this.createColumnElement(
                column,
                columnIndex
            );

            this.boardElement.appendChild(columnElement);
        });

        if (!this.columns.length) {
            const empty = document.createElement('div');

            empty.className = 'kanban-no-columns';
            empty.innerHTML = `
                <strong>На доске нет колонок</strong>
                <span>Добавьте первую колонку.</span>
            `;

            this.boardElement.appendChild(empty);
        }

        this.saveCachedBoard();
    }

    createColumnElement(column, columnIndex) {
        const element = document.createElement('section');

        element.className = 'kanban-column';
        element.dataset.columnId = String(column.id);

        const header = document.createElement('header');

        header.className = 'kanban-column-header';
        header.draggable = true;

        const title = document.createElement('strong');
        title.className = 'kanban-column-title';
        title.textContent = column.name;

        const count = document.createElement('span');
        count.className = 'kanban-column-count';
        count.textContent = String(
            this.getColumnCards(column.id).length
        );

        const actions = document.createElement('span');
        actions.className = 'kanban-column-actions';

        const moveLeft = this.iconButton(
            '←',
            'Сдвинуть колонку влево'
        );

        const moveRight = this.iconButton(
            '→',
            'Сдвинуть колонку вправо'
        );

        const edit = this.iconButton(
            '✎',
            'Переименовать колонку'
        );

        const remove = this.iconButton(
            '×',
            'Удалить колонку',
            'danger'
        );

        moveLeft.disabled = columnIndex === 0;
        moveRight.disabled =
            columnIndex === this.columns.length - 1;

        moveLeft.onclick = event => {
            event.stopPropagation();
            this.shiftColumn(column.id, -1);
        };

        moveRight.onclick = event => {
            event.stopPropagation();
            this.shiftColumn(column.id, 1);
        };

        edit.onclick = event => {
            event.stopPropagation();
            this.renameColumn(column);
        };

        remove.onclick = event => {
            event.stopPropagation();
            this.deleteColumn(column);
        };

        actions.append(
            moveLeft,
            moveRight,
            edit,
            remove
        );

        header.append(title, count, actions);

        const cardsElement = document.createElement('div');
        cardsElement.className = 'kanban-cards';
        cardsElement.dataset.columnId = String(column.id);

        this.getColumnCards(column.id).forEach(card => {
            cardsElement.appendChild(
                this.createCardElement(card)
            );
        });

        const addButton = document.createElement('button');

        addButton.type = 'button';
        addButton.className = 'kanban-add-card';
        addButton.textContent = '＋ Добавить карточку';

        addButton.onclick = () => {
            this.openCardModal(null, column.id);
        };

        this.bindColumnDragAndDrop(
            element,
            header,
            cardsElement,
            column
        );

        element.append(
            header,
            cardsElement,
            addButton
        );

        return element;
    }

    createCardElement(card) {
        const element = document.createElement('article');

        element.className = 'kanban-card';
        element.dataset.cardId = String(card.id);
        element.draggable = true;

        if (Number(card.priority) > 0) {
            element.classList.add(
                `priority-${Number(card.priority)}`
            );
        }

        const title = document.createElement('div');

        title.className = 'kanban-card-title';
        title.textContent = card.title;

        element.appendChild(title);

        const badges = document.createElement('div');
        badges.className = 'kanban-card-badges';

        if (card.due_date) {
            const due = document.createElement('span');

            due.className = 'kanban-card-due';
            due.textContent = this.formatDate(card.due_date);

            if (this.isOverdue(card.due_date)) {
                due.classList.add('overdue');
            }

            badges.appendChild(due);
        }

        if (card.assigned_user_id) {
            const userBadge = document.createElement('span');

            userBadge.className = 'kanban-card-user';
            userBadge.textContent = this.userInitials(card);

            const userName = card.assigned_username
                || card.assigned_login
                || '';

            userBadge.title = userName;
            badges.appendChild(userBadge);
        }

        if (card.description) {
            const descriptionBadge = document.createElement('span');

            descriptionBadge.className = 'kanban-card-description';
            descriptionBadge.textContent = '≡';
            descriptionBadge.title = 'Есть описание';

            badges.appendChild(descriptionBadge);
        }

        if (badges.children.length) {
            element.appendChild(badges);
        }

        element.onclick = () => {
            this.openCardModal(card);
        };

        element.addEventListener('dragstart', event => {
            this.dragCardId = Number(card.id);
            this.dragColumnId = null;

            element.classList.add('dragging');

            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData(
                'text/plain',
                `card:${card.id}`
            );
        });

        element.addEventListener('dragend', () => {
            this.dragCardId = null;
            element.classList.remove('dragging');

            this.boardElement
                .querySelectorAll('.drag-over')
                .forEach(item => {
                    item.classList.remove('drag-over');
                });
        });

        return element;
    }

    bindColumnDragAndDrop(
        columnElement,
        header,
        cardsElement,
        column
    ) {
        header.addEventListener('dragstart', event => {
            if (
                event.target.closest(
                    '.kanban-column-actions'
                )
            ) {
                event.preventDefault();
                return;
            }

            this.dragColumnId = Number(column.id);
            this.dragCardId = null;

            columnElement.classList.add('column-dragging');

            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData(
                'text/plain',
                `column:${column.id}`
            );
        });

        header.addEventListener('dragend', () => {
            this.dragColumnId = null;
            columnElement.classList.remove('column-dragging');

            this.boardElement
                .querySelectorAll('.column-drag-over')
                .forEach(item => {
                    item.classList.remove('column-drag-over');
                });
        });

        columnElement.addEventListener('dragover', event => {
            if (!this.dragColumnId) {
                return;
            }

            event.preventDefault();
            columnElement.classList.add('column-drag-over');
        });

        columnElement.addEventListener('dragleave', event => {
            if (!columnElement.contains(event.relatedTarget)) {
                columnElement.classList.remove(
                    'column-drag-over'
                );
            }
        });

        columnElement.addEventListener('drop', event => {
            if (!this.dragColumnId) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            columnElement.classList.remove(
                'column-drag-over'
            );

            this.moveColumnBefore(
                this.dragColumnId,
                Number(column.id)
            );
        });

        cardsElement.addEventListener('dragover', event => {
            if (!this.dragCardId) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            event.dataTransfer.dropEffect = 'move';
            cardsElement.classList.add('drag-over');
        });

        cardsElement.addEventListener('dragleave', event => {
            if (!cardsElement.contains(event.relatedTarget)) {
                cardsElement.classList.remove('drag-over');
            }
        });

        cardsElement.addEventListener('drop', event => {
            if (!this.dragCardId) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            cardsElement.classList.remove('drag-over');

            const targetIndex = this.getDropIndex(
                cardsElement,
                event.clientY,
                this.dragCardId
            );

            this.moveCard(
                this.dragCardId,
                Number(column.id),
                targetIndex
            );
        });
    }

    getDropIndex(container, clientY, draggedCardId) {
        const elements = [
            ...container.querySelectorAll('.kanban-card'),
        ].filter(element => {
            return Number(element.dataset.cardId)
                !== Number(draggedCardId);
        });

        for (let index = 0; index < elements.length; index++) {
            const rect = elements[index].getBoundingClientRect();

            if (clientY < rect.top + rect.height / 2) {
                return index;
            }
        }

        return elements.length;
    }

    getColumnCards(columnId) {
        return this.cards
            .filter(card => {
                return Number(card.column_id)
                    === Number(columnId);
            })
            .sort((a, b) => {
                return Number(a.position) - Number(b.position)
                    || Number(a.id) - Number(b.id);
            });
    }

    async createBoard() {
        const name = prompt(
            'Название новой доски:',
            'Новая доска'
        )?.trim();

        if (!name) {
            return;
        }

        try {
            const result = await this.context.api(
                'save_board',
                {
                    name,
                    description: '',
                }
            );

            await this.loadBoards(false);
            await this.loadBoard(Number(result.id));
        } catch (error) {
            alert(error.message);
        }
    }

    async editBoard() {
        if (!this.board?.id) {
            return;
        }

        const name = prompt(
            'Название доски:',
            this.board.name || ''
        )?.trim();

        if (!name) {
            return;
        }

        const description = prompt(
            'Описание доски:',
            this.board.description || ''
        );

        if (description === null) {
            return;
        }

        try {
            await this.context.api('save_board', {
                board_id: Number(this.board.id),
                name,
                description: description.trim(),
            });

            await this.loadBoards(false);
            await this.loadBoard(Number(this.board.id));
        } catch (error) {
            alert(error.message);
        }
    }

    async deleteBoard() {
        if (!this.board?.id) {
            return;
        }

        if (
            !confirm(
                `Удалить доску «${this.board.name}» вместе `
                + 'со всеми колонками и карточками?'
            )
        ) {
            return;
        }

        const boardId = Number(this.board.id);

        try {
            await this.context.api('delete_board', {
                board_id: boardId,
            });

            localStorage.removeItem(
                this.boardCacheKey(boardId)
            );

            this.board = null;
            this.columns = [];
            this.cards = [];

            this.context.setParams({ board: null });

            await this.loadBoards();
        } catch (error) {
            alert(error.message);
        }
    }

    async createColumn() {
        if (!this.board?.id) {
            return;
        }

        const name = prompt(
            'Название колонки:',
            'Новая колонка'
        )?.trim();

        if (!name) {
            return;
        }

        try {
            await this.context.api('save_column', {
                board_id: Number(this.board.id),
                name,
                client_uid: this.createUid(),
            });

            await this.loadBoard(Number(this.board.id));
        } catch (error) {
            alert(error.message);
        }
    }

    async renameColumn(column) {
        const name = prompt(
            'Название колонки:',
            column.name
        )?.trim();

        if (!name || name === column.name) {
            return;
        }

        try {
            await this.context.api('save_column', {
                column_id: Number(column.id),
                name,
            });

            column.name = name;
            this.renderBoard();
        } catch (error) {
            alert(error.message);
        }
    }

    async deleteColumn(column) {
        const cardsCount = this.getColumnCards(column.id).length;

        const message = cardsCount > 0
            ? `Удалить колонку «${column.name}» и `
                + `${cardsCount} карточек в ней?`
            : `Удалить колонку «${column.name}»?`;

        if (!confirm(message)) {
            return;
        }

        try {
            await this.context.api('delete_column', {
                column_id: Number(column.id),
            });

            this.columns = this.columns.filter(item => {
                return Number(item.id) !== Number(column.id);
            });

            this.cards = this.cards.filter(card => {
                return Number(card.column_id)
                    !== Number(column.id);
            });

            this.renderBoard();
        } catch (error) {
            alert(error.message);
        }
    }

    async shiftColumn(columnId, direction) {
        const sourceIndex = this.columns.findIndex(column => {
            return Number(column.id) === Number(columnId);
        });

        const targetIndex = sourceIndex + direction;

        if (
            sourceIndex < 0
            || targetIndex < 0
            || targetIndex >= this.columns.length
        ) {
            return;
        }

        const previous = [...this.columns];

        [
            this.columns[sourceIndex],
            this.columns[targetIndex],
        ] = [
            this.columns[targetIndex],
            this.columns[sourceIndex],
        ];

        this.recalculateColumnPositions();
        this.renderBoard();

        try {
            await this.saveColumnOrder();
        } catch (error) {
            this.columns = previous;
            this.renderBoard();
            alert(error.message);
        }
    }

    async moveColumnBefore(sourceId, targetId) {
        if (Number(sourceId) === Number(targetId)) {
            return;
        }

        const previous = [...this.columns];
        const sourceIndex = this.columns.findIndex(column => {
            return Number(column.id) === Number(sourceId);
        });

        const targetIndex = this.columns.findIndex(column => {
            return Number(column.id) === Number(targetId);
        });

        if (sourceIndex < 0 || targetIndex < 0) {
            return;
        }

        const [column] = this.columns.splice(sourceIndex, 1);
        const newTargetIndex = this.columns.findIndex(item => {
            return Number(item.id) === Number(targetId);
        });

        this.columns.splice(newTargetIndex, 0, column);

        this.recalculateColumnPositions();
        this.renderBoard();

        try {
            await this.saveColumnOrder();
        } catch (error) {
            this.columns = previous;
            this.renderBoard();
            alert(error.message);
        }
    }

    recalculateColumnPositions() {
        this.columns.forEach((column, index) => {
            column.position = (index + 1) * 1024;
        });
    }

    async saveColumnOrder() {
        await this.context.api('reorder_columns', {
            board_id: Number(this.board.id),
            column_ids: this.columns.map(column => {
                return Number(column.id);
            }),
        });
    }

    openCardModal(card = null, columnId = null) {
        if (!this.board?.id || !this.columns.length) {
            return;
        }

        this.currentCard = card
            ? { ...card }
            : {
                id: null,
                client_uid: this.createUid(),
                board_id: Number(this.board.id),
                column_id: Number(
                    columnId || this.columns[0].id
                ),
                title: '',
                description: '',
                priority: 0,
                due_date: '',
                assigned_user_id: '',
            };

        this.renderCardModalOptions();

        const form = this.cardForm;
        const current = this.currentCard;

        form.elements.title.value = current.title || '';
        form.elements.column_id.value = String(
            current.column_id || this.columns[0].id
        );
        form.elements.priority.value = String(
            Number(current.priority || 0)
        );
        form.elements.due_date.value = current.due_date || '';
        form.elements.assigned_user_id.value =
            current.assigned_user_id
                ? String(current.assigned_user_id)
                : '';
        form.elements.description.value =
            current.description || '';

        this.modal.querySelector(
            '#kanban-card-modal-title'
        ).textContent = current.id
            ? 'Редактор карточки'
            : 'Новая карточка';

        this.cardDeleteButton.style.display =
            current.id ? '' : 'none';

        this.modal.classList.add('open');

        setTimeout(() => {
            form.elements.title.focus();
        }, 50);
    }

    renderCardModalOptions() {
        const columnSelect = this.cardForm.elements.column_id;
        const userSelect = this.cardForm.elements.assigned_user_id;

        columnSelect.innerHTML = '';

        this.columns.forEach(column => {
            const option = document.createElement('option');

            option.value = String(column.id);
            option.textContent = column.name;

            columnSelect.appendChild(option);
        });

        userSelect.innerHTML = '';

        const noUser = document.createElement('option');

        noUser.value = '';
        noUser.textContent = 'Не назначен';

        userSelect.appendChild(noUser);

        this.users.forEach(user => {
            const option = document.createElement('option');

            option.value = String(user.id);
            option.textContent =
                user.username || user.login || `#${user.id}`;

            userSelect.appendChild(option);
        });
    }

    async saveCard() {
        if (!this.currentCard || !this.board?.id) {
            return;
        }

        const form = this.cardForm;
        const title = form.elements.title.value.trim();

        if (!title) {
            alert('Введите название карточки');
            form.elements.title.focus();
            return;
        }

        const oldColumnId = Number(
            this.currentCard.column_id
        );

        const data = {
            id: this.currentCard.id || undefined,
            client_uid: this.currentCard.client_uid
                || this.createUid(),
            board_id: Number(this.board.id),
            column_id: Number(form.elements.column_id.value),
            title,
            description:
                form.elements.description.value.trim(),
            priority: Number(form.elements.priority.value),
            due_date: form.elements.due_date.value,
            assigned_user_id:
                form.elements.assigned_user_id.value
                    ? Number(
                        form.elements.assigned_user_id.value
                    )
                    : null,
        };

        this.cardSaveButton.disabled = true;

        try {
            await this.context.api('save_card', { data });

            this.closeCardModal();
            await this.loadBoard(Number(this.board.id));

            if (
                this.currentCard?.id
                && oldColumnId !== Number(data.column_id)
            ) {
                this.scrollToColumn(data.column_id);
            }
        } catch (error) {
            alert(error.message);
        } finally {
            this.cardSaveButton.disabled = false;
        }
    }

    async deleteCard() {
        if (!this.currentCard?.id) {
            return;
        }

        if (
            !confirm(
                `Удалить карточку «${this.currentCard.title}»?`
            )
        ) {
            return;
        }

        try {
            await this.context.api('delete_card', {
                card_id: Number(this.currentCard.id),
            });

            const cardId = Number(this.currentCard.id);

            this.cards = this.cards.filter(card => {
                return Number(card.id) !== cardId;
            });

            this.closeCardModal();
            this.renderBoard();
        } catch (error) {
            alert(error.message);
        }
    }

    closeCardModal() {
        this.modal.classList.remove('open');
        this.currentCard = null;
    }

    async moveCard(cardId, targetColumnId, targetIndex) {
        const card = this.cards.find(item => {
            return Number(item.id) === Number(cardId);
        });

        if (!card) {
            return;
        }

        const previousCards = this.cards.map(item => ({
            ...item,
        }));

        this.moveCardLocally(
            cardId,
            targetColumnId,
            targetIndex
        );

        this.renderBoard();

        try {
            await this.context.api('move_card', {
                card_id: Number(cardId),
                column_id: Number(targetColumnId),
                target_index: Number(targetIndex),
            });

            this.saveCachedBoard();
        } catch (error) {
            this.cards = previousCards;
            this.renderBoard();
            alert(error.message);
        }
    }

    moveCardLocally(cardId, targetColumnId, targetIndex) {
        const card = this.cards.find(item => {
            return Number(item.id) === Number(cardId);
        });

        if (!card) {
            return;
        }

        const sourceColumnId = Number(card.column_id);

        const targetCards = this.getColumnCards(targetColumnId)
            .filter(item => {
                return Number(item.id) !== Number(cardId);
            });

        targetIndex = Math.max(
            0,
            Math.min(targetIndex, targetCards.length)
        );

        card.column_id = Number(targetColumnId);

        targetCards.splice(targetIndex, 0, card);

        targetCards.forEach((item, index) => {
            item.position = (index + 1) * 1024;
        });

        if (sourceColumnId !== Number(targetColumnId)) {
            this.getColumnCards(sourceColumnId)
                .filter(item => {
                    return Number(item.id) !== Number(cardId);
                })
                .forEach((item, index) => {
                    item.position = (index + 1) * 1024;
                });
        }
    }

    scrollToColumn(columnId) {
        requestAnimationFrame(() => {
            const element = this.boardElement.querySelector(
                `[data-column-id="${Number(columnId)}"]`
            );

            element?.scrollIntoView({
                behavior: 'smooth',
                block: 'nearest',
                inline: 'center',
            });
        });
    }

    iconButton(text, title, type = '') {
        const button = document.createElement('button');

        button.type = 'button';
        button.className = 'kanban-column-action';

        if (type === 'danger') {
            button.classList.add('danger');
        }

        button.textContent = text;
        button.title = title;
        button.setAttribute('aria-label', title);

        return button;
    }

    setConnection(status, message = '') {
        if (!this.connectionElement) {
            return;
        }

        const labels = {
            online: 'Синхронизировано',
            loading: 'Загрузка…',
            offline: 'Офлайн: показана сохранённая копия',
            error: 'Ошибка загрузки',
        };

        this.connectionElement.className =
            `kanban-connection ${status}`;

        this.connectionElement.textContent =
            message && status === 'error'
                ? message
                : labels[status] || '';

        this.connectionElement.title = message || '';
    }

    saveCachedBoard() {
        if (!this.board?.id) {
            return;
        }

        try {
            localStorage.setItem(
                this.boardCacheKey(this.board.id),
                JSON.stringify({
                    board: this.board,
                    columns: this.columns,
                    cards: this.cards,
                    users: this.users,
                    saved_at: Date.now(),
                })
            );
        } catch {
            // localStorage мог быть отключён или переполнен.
        }
    }

    restoreCachedBoard(requestedBoardId = null) {
        try {
            const boardId = Number(
                requestedBoardId
                || this.context.getParam('board')
                || localStorage.getItem(this.lastBoardKey)
            );

            if (boardId <= 0) {
                return false;
            }

            const raw = localStorage.getItem(
                this.boardCacheKey(boardId)
            );

            if (!raw) {
                return false;
            }

            const data = JSON.parse(raw);

            if (!data?.board?.id) {
                return false;
            }

            this.board = data.board;
            this.columns = Array.isArray(data.columns)
                ? data.columns
                : [];
            this.cards = Array.isArray(data.cards)
                ? data.cards
                : [];
            this.users = Array.isArray(data.users)
                ? data.users
                : [];

            this.renderBoardSelect();
            this.renderBoard();

            return true;
        } catch {
            return false;
        }
    }

    boardCacheKey(boardId) {
        return `${this.cachePrefix}-board-${Number(boardId)}`;
    }

    formatDate(value) {
        const [year, month, day] = String(value).split('-');

        if (!year || !month || !day) {
            return String(value);
        }

        return `${day}.${month}`;
    }

    isOverdue(value) {
        if (!value) {
            return false;
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const due = new Date(`${value}T00:00:00`);

        return Number.isFinite(due.getTime())
            && due < today;
    }

    userInitials(card) {
        const source = String(
            card.assigned_username
            || card.assigned_login
            || '?'
        ).trim();

        const words = source.split(/\s+/).filter(Boolean);

        if (words.length >= 2) {
            return (
                words[0][0] + words[1][0]
            ).toUpperCase();
        }

        return source.slice(0, 2).toUpperCase();
    }

    createUid() {
        if (crypto.randomUUID) {
            return crypto.randomUUID();
        }

        return `${Date.now()}-${Math.random()
            .toString(16)
            .slice(2)}`;
    }

    async destroy() {
        this.destroyed = true;

        window.removeEventListener(
            'online',
            this.onlineHandler
        );

        window.removeEventListener(
            'offline',
            this.offlineHandler
        );

        this.modal?.remove();
        this.panel.innerHTML = '';

        this.boards = [];
        this.board = null;
        this.columns = [];
        this.cards = [];
        this.users = [];
    }
}