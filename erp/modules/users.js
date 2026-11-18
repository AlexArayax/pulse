export default class Users {
    constructor(context) {
        this.context = context;
        this.panel = context.panel;
        this.items = [];
        this.current = null;

        this.render();
        this.createModal();
        this.load();
    }

    render() {
        this.panel.innerHTML = `
            <section class="users-module">
                <div class="users-toolbar">
                    <input
                        id="users-search"
                        type="search"
                        placeholder="Поиск"
                    >

                    <button
                        id="users-create"
                        class="primary-button"
                        type="button"
                    >Новый пользователь</button>
                </div>

                <div class="users-table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>Логин</th>
                                <th>Имя</th>
                                <th>Роль</th>
                                <th>Сканер</th>
                                <th>Активен</th>
                                <th>Последний вход</th>
                            </tr>
                        </thead>
                        <tbody></tbody>
                    </table>
                </div>
            </section>
        `;

        this.search = this.panel.querySelector('#users-search');

        this.search.oninput = () => this.renderRows();

        this.panel.querySelector('#users-create').onclick = () => {
            this.open(null);
        };
    }

    createModal() {
        this.modal = document.createElement('div');
        this.modal.className = 'erp-modal';

        this.modal.innerHTML = `
            <div class="erp-modal-card">
                <header class="erp-modal-header">
                    <strong>Пользователь</strong>
                    <button
                        class="erp-modal-close"
                        type="button"
                    >×</button>
                </header>

                <form class="erp-modal-body erp-form-grid">
                    <label class="erp-field">
                        Логин
                        <input name="login" required>
                    </label>

                    <label class="erp-field">
                        Имя
                        <input name="username">
                    </label>

                    <label class="erp-field">
                        Роль
                        <select name="role">
                            <option value="user">Пользователь</option>
                            <option value="admin">Администратор</option>
                        </select>
                    </label>

                    <label class="erp-field">
                        Тип сканера
                        <select name="scantype">
                            <option value="1">Фудтрак / месяц</option>
                            <option value="2">Душ / день</option>
                            <option value="3">Кухня</option>
                        </select>
                    </label>

                    <label class="erp-field">
                        QR-ключ устройства
                        <input name="qrkey">
                    </label>

                    <label class="erp-field">
                        Модули
                        <input
                            name="trees"
                            placeholder="chains,feeder"
                        >
                    </label>

                    <label class="erp-field full">
                        Информация
                        <textarea name="info"></textarea>
                    </label>

                    <label class="erp-field full">
                        Пароль
                        <span class="users-password">
                            <input
                                name="password"
                                type="text"
                                placeholder="Оставьте пустым, чтобы не менять"
                            >
                            <button
                                id="generate-password"
                                class="secondary-button"
                                type="button"
                            >Создать</button>
                        </span>
                    </label>

                    <label class="users-active full">
                        <input
                            name="active"
                            type="checkbox"
                            value="1"
                        >
                        Активен
                    </label>
                </form>

                <footer class="erp-modal-footer">
                    <button
                        id="user-delete"
                        class="danger-button"
                        type="button"
                    >Удалить</button>

                    <button
                        id="user-save"
                        class="primary-button"
                        type="button"
                    >Сохранить</button>
                </footer>
            </div>
        `;

        document.body.appendChild(this.modal);

        this.form = this.modal.querySelector('form');

        this.modal.querySelector('.erp-modal-close').onclick = () => {
            this.close();
        };

        this.modal.querySelector('#user-save').onclick = () => {
            this.save();
        };

        this.modal.querySelector('#user-delete').onclick = () => {
            this.delete();
        };

        this.modal.querySelector('#generate-password').onclick = () => {
            this.form.elements.password.value =
                this.generatePassword();
        };

        this.modal.onclick = event => {
            if (event.target === this.modal) {
                this.close();
            }
        };
    }

    async load() {
        try {
            const response = await this.context.api('list');

            this.items = response.items || [];
            this.renderRows();
        } catch (error) {
            this.panel.innerHTML = `
                <div class="error-box">${error.message}</div>
            `;
        }
    }

    renderRows() {
        const query = this.search.value.trim().toLowerCase();
        const body = this.panel.querySelector('tbody');

        body.innerHTML = '';

        this.items
            .filter(item => {
                return !query
                    || `${item.login} ${item.username || ''}`
                        .toLowerCase()
                        .includes(query);
            })
            .forEach(item => {
                const row = document.createElement('tr');

                [
                    item.id,
                    item.login,
                    item.username || '—',
                    item.role,
                    item.scantype,
                    Number(item.active) ? 'Да' : 'Нет',
                    item.last_login_at || '—',
                ].forEach(value => {
                    const cell = document.createElement('td');
                    cell.textContent = value;
                    row.appendChild(cell);
                });

                row.onclick = () => this.open(item);
                body.appendChild(row);
            });
    }

    open(item) {
        this.current = item;

        const values = {
            login: item?.login || '',
            username: item?.username || '',
            role: item?.role || 'user',
            scantype: item?.scantype || 1,
            qrkey: item?.qrkey || '',
            trees: item?.trees || '',
            info: item?.info || '',
            active: item ? Number(item.active) === 1 : true,
        };

        Object.entries(values).forEach(([key, value]) => {
            const field = this.form.elements[key];

            if (!field) {
                return;
            }

            if (field.type === 'checkbox') {
                field.checked = Boolean(value);
            } else {
                field.value = value;
            }
        });

        this.form.elements.password.value = '';

        this.modal.querySelector('#user-delete').style.display =
            item ? '' : 'none';

        this.modal.classList.add('open');
    }

    async save() {
        const data = Object.fromEntries(new FormData(this.form));

        data.active = this.form.elements.active.checked ? 1 : 0;

        if (this.current) {
            data.id = this.current.id;
        }

        try {
            await this.context.api('save', { data });
            this.close();
            await this.load();
        } catch (error) {
            alert(error.message);
        }
    }

    async delete() {
        if (
            !this.current
            || !confirm(`Удалить ${this.current.login}?`)
        ) {
            return;
        }

        try {
            await this.context.api('delete', {
                id: this.current.id,
            });

            this.close();
            await this.load();
        } catch (error) {
            alert(error.message);
        }
    }

    generatePassword(length = 14) {
        const chars =
            'ABCDEFGHJKLMNPQRSTUVWXYZ'
            + 'abcdefghijkmnopqrstuvwxyz'
            + '23456789';

        const bytes = crypto.getRandomValues(
            new Uint8Array(length)
        );

        return Array.from(
            bytes,
            byte => chars[byte % chars.length]
        ).join('');
    }

    close() {
        this.modal.classList.remove('open');
    }

    destroy() {
        this.modal?.remove();
        this.panel.innerHTML = '';
    }
}