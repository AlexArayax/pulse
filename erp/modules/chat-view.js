export function createId() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function makeError(message, status = 0) {
    return Object.assign(new Error(message), { statusCode: status });
}

export function escapeHtml(value) {
    return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

export function attachmentError(stage, error, details = {}) {
    console.error(`[Chat attachment] ${stage}`, { ...details, error });
}

const AI_OPTIONS = [
    ['off', 'Выключено'],
    ['post', 'А — Ответить на следующий пост'],
    ['summary', 'Б — Следующий пост с контекстом чата'],
    ['dialog', 'В — Ответить на весь диалог сейчас'],
    ['image', 'Г — Ответить картинкой на следующий пост']
];

const ICONS = {
    menu: '<path d="M4 6h16M4 12h16M4 18h16"></path>',
    plus: '<path d="M12 4v16M4 12h16"></path>',
    pin: '<path d="m16 3 5 5-4 1-4 4-1 5-3-3-6 6 6-6-3-3 5-1 4-4 1-4Z"></path>',
    unpin: '<path d="m3 3 18 18M9 15l-6 6M16 3l5 5-4 1-2 2M7 10l-1 2 6 6 1-5M11 11l4-4 1-4"></path>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"></rect><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"></path>',
    edit: '<path d="m16 3 5 5-12 12-6 1 1-6L16 3ZM14 5l5 5"></path>',
    delete: '<path d="M3 6h18M9 6V4h6v2M5 6l1 15h12l1-15M10 10v7M14 10v7"></path>',
    react: '<circle cx="12" cy="12" r="9"></circle><path d="M8 14a4 4 0 0 0 8 0M8 9h.01M16 9h.01"></path>',
    reply: '<path d="m9 5-6 6 6 6M3 11h10a7 7 0 0 1 7 7v1"></path>',
    check: '<path d="m5 12 4 4L19 6"></path>',
    warning: '<path d="m12 3 10 18H2L12 3ZM12 9v5M12 17h.01"></path>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m16 16 5 5"></path>'
};

const MESSAGE_TYPES = new Set(['text', 'image', 'file']);
const POSITIVE_ID = value => Number.isSafeInteger(value) && value > 0;
const viewPause = () => new Promise(resolve => setTimeout(resolve, 0));

function element(tag, className = '', text = null) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== null) node.textContent = text;
    return node;
}

function readMeta(value, name) {
    const body = String(value ?? '');
    const pattern = new RegExp(`^<meta\\s+name="${name}"\\s+content="([^"]{1,6000})"\\s*\\/?>[ \\t]*(?:\\r?\\n)?`, 'i');
    const match = body.match(pattern);
    if (!match) return null;
    try {
        return { data: JSON.parse(decodeURIComponent(match[1])), text: body.slice(match[0].length), prefix: match[0].trimEnd() };
    } catch {
        return null;
    }
}

function writeMeta(name, data) {
    return `<meta name="${name}" content="${encodeURIComponent(JSON.stringify(data))}">`;
}

function safeLink(value) {
    try {
        const raw = String(value || '').trim();
        const url = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw);
        return ['http:', 'https:', 'mailto:', 'tel:', 'tg:'].includes(url.protocol) ? url.href : '';
    } catch {
        return '';
    }
}

function createLink(url) {
    return Object.assign(element('a'), { href: url, target: '_blank', rel: 'noopener noreferrer' });
}

function datestring(value) {
    return new Date(String(value || '').replace(' ', 'T'));
}

export default class ChatView {
    iconMarkup(name) {
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ICONS.react}</svg>`;
    }

async openEditMembersDialog() {
    const chat = this.currentChat;
    if (this.destroyed || this.modal || this.loading || this.membersDialogLoading) return;
    if (!this.chats.some(entry => Number(entry.chat) === chat && entry.canEditMembers === true)) return;
    if (!navigator.onLine) return this.notify('Для изменения состава чата требуется подключение.');

    this.membersDialogLoading = true;
    let response;
    try {
        response = await this.context.api('getChatMembers', { chat });
    } catch (error) {
        if (!this.destroyed) this.notify(error.message || 'Не удалось загрузить участников.');
        return;
    } finally {
        this.membersDialogLoading = false;
    }

    if (this.destroyed || this.modal || this.loading || this.currentChat !== chat) return;

    const overlay = this.makeModal('Редактировать участников');
    const modal = overlay.querySelector('.chat-modal');
    const hint = element('p', 'chat-create-hint', 'Выберите до 10 участников, включая создателя. Удалённые участники потеряют доступ к чату.');
    const list = element('div', 'chat-users-list');
    const count = element('div', 'chat-search-status');
    count.setAttribute('role', 'status');
    const errorNode = element('div', 'chat-modal-error');
    errorNode.setAttribute('role', 'alert');

    const ownerId = Number(response.ownerId);
    const expectedMemberIds = response.memberIds.map(Number);
    const selected = new Set(expectedMemberIds);
    const boxes = [];

    for (const user of response.users) {
        const id = Number(user.id);
        const owner = id === ownerId;
        const row = element('label', 'chat-user-row');
        const box = Object.assign(element('input'), {
            type: 'checkbox',
            checked: selected.has(id)
        });
        const suffix = owner ? ' — создатель' : user.active ? '' : ' — отключён';
        row.append(box, element('span', '', (user.username || `Пользователь ${id}`) + suffix));
        list.append(row);
        boxes.push({ box, id, owner, active: user.active });

        box.onchange = () => {
            if (box.checked) selected.add(id);
            else selected.delete(id);
            errorNode.textContent = '';
            update();
        };
    }

    const buttons = element('div', 'chat-modal-buttons');
    const cancel = this.actionButton('', 'Отмена');
    const save = this.actionButton('chat-create-confirm', 'Сохранить');
    const reload = this.actionButton('', 'Обновить список');
    const cross = overlay.querySelector('.chat-search-close');
    reload.hidden = true;
    buttons.append(cancel, reload, save);
    modal.append(hint, list, count, errorNode, buttons);

    let busy = false;
    let stale = false;
    const update = () => {
        count.textContent = `Выбрано: ${selected.size} из 10`;
        for (const { box, id, owner, active } of boxes) {
            box.disabled = busy || stale || owner || (!box.checked && (!active || selected.size >= 10));
        }
        const changed = selected.size !== expectedMemberIds.length
            || expectedMemberIds.some(id => !selected.has(id));
        save.disabled = busy || stale || !changed || selected.size > 10;
        cancel.disabled = cross.disabled = reload.disabled = busy;
    };

    const close = this.mountModal(overlay, () => !busy);
    cross.onclick = cancel.onclick = close;
    reload.onclick = () => {
        if (close()) void this.openEditMembersDialog();
    };
    save.onclick = async () => {
        if (busy || stale || save.disabled) return;
        busy = true;
        errorNode.textContent = '';
        update();

        try {
            const result = await this.context.api('setChatMembers', {
                chat,
                memberIds: [...selected],
                expectedMemberIds
            });
            if (this.destroyed) return;
            this.applyMeta(result.chat);
            this.setConnection(true);
            busy = false;
            close();
            this.notify('Состав чата сохранён.', false);
        } catch (error) {
            if (this.destroyed) return;
            busy = false;
            stale = this.errorStatus(error) === 409;
            reload.hidden = !stale;
            errorNode.textContent = error.message || 'Не удалось сохранить состав чата.';
            update();
            if (stale) reload.focus({ preventScroll: true });
        }
    };

    update();
    (list.querySelector('input:not(:disabled)') || cancel).focus({ preventScroll: true });
}

    setButtonIcon(button, icon, title) {
        button.innerHTML = this.iconMarkup(icon);
        button.title = title;
        button.setAttribute('aria-label', title);
    }

    actionButton(className, text, title = text) {
        return Object.assign(element('button', className, text), { type: 'button', title });
    }

    iconButton(className, icon, title) {
        const button = this.actionButton(`${className} chat-icon-button`, '');
        this.setButtonIcon(button, icon, title);
        return button;
    }

    render() {
        this.panel.innerHTML = `
            <section class="chat-wrapper">
                <div class="chat-card">
                    <header class="chat-header">
                        <div class="chat-header-left">
                            <i id="chat-connection" class="chat-connection offline" role="status" title="Нет соединения" aria-label="Нет соединения"></i>
                            <div id="chat-tabs" role="tablist" aria-label="Чаты"></div>
                        </div>
                        <button id="chat-menu" type="button" title="Меню чата" aria-label="Меню чата" aria-haspopup="dialog" aria-expanded="false">${this.iconMarkup('menu')}</button>
                    </header>
                    <div id="chat-notice" class="chat-notice" role="status" hidden></div>
                    <div id="chat-pinned" class="chat-pinned-bar" hidden>
                        <button id="chat-pinned-main" class="chat-pinned-main" type="button" title="Перейти к закреплённому сообщению">
                            ${this.iconMarkup('pin')}
                            <span class="chat-pinned-lines">
                                <span id="chat-pinned-title" class="chat-pinned-title"></span>
                                <span id="chat-pinned-text" class="chat-pinned-text"></span>
                            </span>
                        </button>
                        <button id="chat-pinned-list" class="chat-pinned-list-button" type="button" aria-label="Все закреплённые сообщения"></button>
                    </div>
                    <div id="chat-window" class="chat-window" aria-label="Сообщения" tabindex="0"></div>
                    <footer class="chat-input-area">
                        <div class="chat-composer">
                            <div id="chat-reply-composer" class="chat-reply-composer" hidden>
                                <div id="chat-reply-target"></div>
                                <button id="chat-reply-cancel" class="chat-reply-cancel" type="button" title="Отменить ответ" aria-label="Отменить ответ">×</button>
                            </div>
                            <div class="chat-textarea-wrapper">
                                <textarea id="chat-message" rows="1" maxlength="50000" placeholder="Введите сообщение…" aria-label="Сообщение"></textarea>
                                <button id="chat-attach" class="chat-attach" type="button" title="Прикрепить файл" aria-label="Прикрепить файл">📎</button>
                            </div>
                        </div>
                        <button id="chat-send" class="chat-send" type="button" title="Отправить" aria-label="Отправить">➤</button>
                        <input id="chat-files" type="file" multiple hidden>
                    </footer>
                </div>
                <div id="chat-menu-content" class="chat-menu-content" hidden>
                    <button id="chat-create" class="chat-menu-action" type="button">${this.iconMarkup('plus')}<span>Создать чат</span></button>
                    <button id="chat-search" class="chat-menu-action" type="button">${this.iconMarkup('search')}<span>Поиск по всем чатам</span></button>
                    <button id="chat-menu-pins" class="chat-menu-action" type="button">${this.iconMarkup('pin')}<span>Закреплённые сообщения</span></button>
                    <label class="chat-menu-row chat-ai-mode"><span>Режим ИИ</span><select id="chat-ai">${AI_OPTIONS.map(([mode, label]) => `<option value="${mode}">${label}</option>`).join('')}</select></label>
					<button id="chat-edit-members" class="chat-menu-action" type="button" hidden>${this.iconMarkup('plus')}<span>Редактировать участников</span></button>
                    <label class="chat-menu-row"><span>Цвет вкладки</span><input id="chat-color" type="color" value="#334155"></label>
                </div>
                <div id="chat-lightbox" class="chat-lightbox" role="dialog" aria-modal="true" aria-label="Просмотр изображения" tabindex="-1"><img alt="Просмотр изображения"></div>
            </section>`;
        const properties = {
            tabsElement: 'tabs', windowElement: 'window', inputElement: 'message',
            sendElement: 'send', attachElement: 'attach', filesElement: 'files',
            createElement: 'create', searchElement: 'search', connectionElement: 'connection',
            aiElement: 'ai', colorElement: 'color', noticeElement: 'notice',
            replyComposerElement: 'reply-composer', replyTargetElement: 'reply-target',
            replyCancelElement: 'reply-cancel', lightboxElement: 'lightbox',
            menuElement: 'menu', menuContent: 'menu-content', menuPinsElement: 'menu-pins',
            pinnedElement: 'pinned', pinnedMain: 'pinned-main', pinnedTitle: 'pinned-title',
			editMembersElement: 'edit-members',
            pinnedText: 'pinned-text', pinnedList: 'pinned-list'
        };
        for (const [property, id] of Object.entries(properties)) this[property] = this.panel.querySelector(`#chat-${id}`);
        this.wrapper = this.panel.querySelector('.chat-wrapper');
        this.lightboxImage = this.lightboxElement.querySelector('img');
        this.updateControls();
    }

    bindEvents() {
		this.editMembersElement.hidden = !this.chats.some(
    chat => Number(chat.chat) === this.currentChat && chat.canEditMembers === true
);
        this.onOnline = () => {
            this.updateControls();
            if (!this.initialized) return void this.init();
            this.processOutbox();
            void this.pollCurrentChat();
            void this.refreshChatStatus();
        };
        this.onOffline = () => {
            this.setConnection(false);
            this.updateControls();
            this.renderPendingMessages();
        };
        this.onVisibility = () => {
            if (document.hidden) this.closeReactionPicker();
            else {
                this.finishOpeningScroll();
                void this.pollCurrentChat();
                void this.refreshChatStatus();
            }
        };
        this.onDocumentClick = event => {
            if (!event.target.closest?.('.chat-reaction-picker,.chat-message-react')) this.closeReactionPicker();
        };
        this.onKeydown = event => this.handleGlobalKey(event);
        this.onResize = () => {
            this.scheduleFolds();
            this.schedulePickerPosition();
        };
        this.onScroll = event => {
            if (!this.reactionPickerElement?.contains(event.target)) this.schedulePickerPosition();
        };
        window.addEventListener('online', this.onOnline);
        window.addEventListener('offline', this.onOffline);
        window.addEventListener('keydown', this.onKeydown);
        window.addEventListener('resize', this.onResize);
        document.addEventListener('visibilitychange', this.onVisibility);
        document.addEventListener('click', this.onDocumentClick);
        document.addEventListener('scroll', this.onScroll, true);
        window.visualViewport?.addEventListener('resize', this.onResize);
        window.visualViewport?.addEventListener('scroll', this.onScroll);
        if (window.ResizeObserver) {
            this.resizeObserver = new ResizeObserver(this.onResize);
            this.resizeObserver.observe(this.windowElement);
        }
        this.sendElement.onclick = () => { void this.sendMessage(); };
        this.inputElement.onkeydown = event => {
            if (!event.isComposing && event.key === 'Enter' && !event.shiftKey && matchMedia('(min-width:601px)').matches) {
                event.preventDefault();
                void this.sendMessage();
            }
        };
        this.attachElement.onclick = () => this.filesElement.click();
        this.replyCancelElement.onclick = () => this.cancelReply();
        this.replyTargetElement.onclick = event => this.handleReplyLink(event);
        this.menuElement.onclick = () => this.openMenu();
        this.createElement.onclick = () => {
            if (this.modalClose?.() !== false) void this.openCreateDialog();
        };
        this.searchElement.onclick = () => {
            if (this.modalClose?.() !== false) this.openSearchDialog();
        };
        this.menuPinsElement.onclick = () => {
            if (this.modalClose?.() !== false) this.openPinsDialog();
        };
        this.colorElement.onchange = () => { void this.saveChatColor(this.colorElement.value); };
        this.pinnedList.onclick = () => this.openPinsDialog();
        this.pinnedMain.onclick = async () => {
            const chat = this.currentChat;
            const id = this.selectedPinId;
            if (!id || !await this.jumpToMessage(chat, id) || this.currentChat !== chat || this.destroyed) return;
            const index = this.pins.findIndex(pin => pin.id === id);
            if (index >= 0 && this.pins.length > 1) {
                this.selectedPinId = this.pins[(index + 1) % this.pins.length].id;
                this.renderPinnedBar();
            }
        };
        this.tabsElement.onclick = event => {
            const tab = event.target.closest('.chat-tab');
            if (!tab) return;
            const chat = Number(tab.dataset.chat);
            if (event.target.closest('.chat-tab-close')) void this.leaveChat(chat);
            else void this.switchChat(chat);
        };
        this.windowElement.onclick = event => this.handleMessageClick(event);
        this.windowElement.onkeydown = event => {
            if (event.isComposing || !event.target.matches('.chat-edit-textarea')) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                this.cancelEdit();
            } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void this.saveEdit();
            }
        };
        this.lightboxElement.onclick = () => this.closeLightbox();
    }

    handleGlobalKey(event) {
        const lightbox = this.lightboxElement.classList.contains('open');
        if (event.key === 'Escape') {
            if (lightbox) this.closeLightbox();
            else if (this.modal) this.modalClose?.();
            else if (this.reactionPickerId !== null) this.closeReactionPicker(true);
            else if (this.editing) this.cancelEdit();
            else if (this.replyTo && !this.uploadRunning) this.cancelReply();
            else return;
            event.preventDefault();
        }
        const scope = lightbox ? this.lightboxElement : this.modal;
        if (event.key !== 'Tab' || !scope) return;
        const focusable = [...scope.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')]
            .filter(node => node.getClientRects().length);
        const active = document.activeElement;
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first) {
            event.preventDefault();
            (scope.querySelector('[role="dialog"]') || scope).focus();
        } else if (event.shiftKey && (active === first || !focusable.includes(active))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (active === last || !focusable.includes(active))) {
            event.preventDefault();
            first.focus();
        }
    }

    handleMessageClick(event) {
        const target = event.target;
        if (target.closest('.chat-reply-preview')) return this.handleReplyLink(event);
        const spoiler = target.closest('.chat-inline-spoiler');
        if (spoiler) {
            event.preventDefault();
            const revealed = spoiler.classList.toggle('revealed');
            spoiler.setAttribute('aria-expanded', String(revealed));
            spoiler.setAttribute('aria-label', revealed ? 'Скрыть спойлер' : 'Показать спойлер');
            return;
        }
        const node = target.closest('.chat-message');
        if (!node) return;
        const id = Number(node.dataset.id);
        const reaction = target.closest('[data-reaction]');
        if (reaction) return void this.setReaction(id, reaction.dataset.reaction);
        if (target.closest('.chat-message-pin')) return this.openPinConfirm(id);
        if (target.closest('.chat-message-reply')) return this.startReply(id);
        if (target.closest('.chat-message-react')) return this.toggleReactionPicker(id);
        const remove = target.closest('.chat-message-delete');
        if (remove) return this.handleDeleteClick(id, remove);
        if (target.closest('.chat-message-edit')) return this.startEdit(id);
        if (target.closest('.chat-edit-save')) return void this.saveEdit();
        if (target.closest('.chat-edit-cancel')) return this.cancelEdit();
        if (target.closest('.chat-pending-retry,.chat-pending-cancel')) {
            const item = this.outbox.find(entry => entry.clientId === node.dataset.clientId && entry.phase === 'failed');
            if (!item) return;
            if (target.closest('.chat-pending-cancel')) this.removeOutboxItem(item);
            else {
                Object.assign(item, { phase: 'send', attempts: 0, nextAttempt: 0 });
                this.renderPendingMessages();
                void this.saveLocalState().then(() => this.processOutbox());
            }
            return;
        }
        const copy = target.closest('.chat-message-copy');
        if (copy) return void this.copyMessage(id, copy);
        const image = target.closest('.chat-message-image');
        if (image) this.openLightbox(image);
        const tileActions = target.closest('.chat-album-item')?.querySelector(':scope > .chat-message-actions');
        if (tileActions && !target.closest('.chat-message-actions,.chat-reactions,.chat-message-image')) {
            this.setTileControls(node, node.dataset.controlsOpen !== 'true');
        }
    }

    openLightbox(image) {
        this.closeReactionPicker();
        this.lightboxPreviousFocus = document.activeElement;
        this.lightboxImage.src = image.currentSrc || image.src;
        this.lightboxImage.alt = image.alt;
        this.lightboxElement.classList.add('open');
        this.lightboxElement.focus({ preventScroll: true });
    }

    closeLightbox() {
        const open = this.lightboxElement.classList.contains('open');
        this.lightboxElement.classList.remove('open');
        this.lightboxImage.removeAttribute('src');
        if (open && this.lightboxPreviousFocus?.isConnected) this.lightboxPreviousFocus.focus({ preventScroll: true });
    }

    normalizeReply(value) {
        if (!value || typeof value !== 'object') return null;
        const chat = Number(value.chat);
        const id = Number(value.id);
        if (!Number.isSafeInteger(chat) || chat < 0 || !POSITIVE_ID(id)) return null;
        return {
            chat, id,
            author: String(value.author || 'Сообщение').slice(0, 100),
            preview: String(value.preview || '').replace(/\s+/g, ' ').trim().slice(0, 180)
        };
    }

    parseReply(value) {
        const meta = readMeta(value, 'chat-reply');
        const reply = this.normalizeReply(meta?.data);
        return reply ? { reply, text: meta.text } : { reply: null, text: String(value ?? '') };
    }

    composeReply(text, value) {
        const reply = this.normalizeReply(value);
        return reply ? `${writeMeta('chat-reply', reply)}\n${text}` : String(text);
    }

    parseAlbum(value) {
        const meta = readMeta(value, 'chat-album');
        const data = meta?.data;
        const ids = data?.ids ?? data?.imageIds ?? data?.images;
        if (data?.v !== 1 || !Array.isArray(ids) || ids.length < 1 || ids.length > 10) return null;
        const normalized = ids.map(Number);
        if (!normalized.every(POSITIVE_ID) || new Set(normalized).size !== normalized.length) return null;
        const chat = data.chat == null ? null : Number(data.chat);
        if (chat !== null && (!Number.isSafeInteger(chat) || chat < 0)) return null;
        return { ids: normalized, chat, prefix: meta.prefix, text: meta.text };
    }

    messageParts(message) {
        if (message?.type !== 'text') return this.parseReply(message?.body);
        const album = this.parseAlbum(message.body);
        return { ...this.parseReply(album ? album.text : message.body), album };
    }

    parsePin(value) {
        const meta = readMeta(String(value ?? '').trim(), 'chat-pin');
        const data = meta?.data;
        const chat = Number(data?.chat);
        const id = Number(data?.id);
        if (data?.v !== 1 || meta.text.trim() || !Number.isSafeInteger(chat) || chat < 0 || !POSITIVE_ID(id) || typeof data.active !== 'boolean') {
            return null;
        }
        return { chat, id, active: data.active };
    }

    isPinMessage(message) {
        return message?.type === 'text' && !!this.parsePin(message.body);
    }

    composePin(chat, id, active) {
        return writeMeta('chat-pin', { v: 1, chat, id, active });
    }

    messageLink(chat, id) {
        const url = new URL(location.href);
        url.searchParams.set('chat', String(chat));
        url.searchParams.set('message', String(id));
        return url.href;
    }

    messagePreview(message) {
        if (!message) return '';
        if (message.type === 'image') return 'Изображение';
        if (message.type === 'file') return `Файл: ${message.file_name || `attachment-${message.id}`}`.slice(0, 180);
        return this.searchPlainText(message).replace(/\s+/g, ' ').trim().slice(0, 180) || 'Сообщение';
    }

    createReplyPreview(value) {
        const reply = this.normalizeReply(value);
        if (!reply) return null;
        const bucket = this.searchIndex.get(reply.chat);
        const current = reply.chat === this.currentChat;
        const deleted = bucket?.deleted.has(reply.id) || (current && this.deletedIds.has(reply.id));
        const source = deleted ? null : ((current ? this.messages.get(reply.id) : null) || bucket?.messages.get(reply.id));
        const link = element('a', `chat-reply-preview${deleted ? ' is-deleted' : ''}`);
        link.href = this.messageLink(reply.chat, reply.id);
        link.title = deleted ? 'Исходное сообщение удалено' : 'Перейти к исходному сообщению';
        Object.assign(link.dataset, { replyChat: reply.chat, replyId: reply.id, replyAuthor: reply.author, replyPreview: reply.preview });
        const icon = element('span', 'chat-reply-icon');
        icon.innerHTML = this.iconMarkup('reply');
        const lines = element('span', 'chat-reply-lines');
        lines.append(
            element('span', 'chat-reply-author', source?.username || reply.author),
            element('span', 'chat-reply-text', deleted ? 'Сообщение удалено' : source ? this.messagePreview(source) : reply.preview || 'Открыть сообщение')
        );
        link.append(icon, lines);
        return link;
    }

    renderReplyComposer() {
        if (this.destroyed) return;
        const bottom = this.nearBottom();
        const preview = this.createReplyPreview(this.replyTo);
        this.replyComposerElement.hidden = !preview;
        this.replyTargetElement.replaceChildren(...(preview ? [preview] : []));
        if (bottom) this.scrollToBottom();
    }

    refreshReplyReferences(id) {
        const selector = `.chat-reply-preview[data-reply-chat="${this.currentChat}"][data-reply-id="${id}"]`;
        for (const link of this.windowElement.querySelectorAll(selector)) {
            const replacement = this.createReplyPreview({
                chat: this.currentChat, id, author: link.dataset.replyAuthor, preview: link.dataset.replyPreview
            });
            if (replacement) link.replaceWith(replacement);
        }
        if (this.replyTo?.chat === this.currentChat && this.replyTo.id === id) this.renderReplyComposer();
    }

    startReply(id) {
        const message = this.messages.get(id);
        if (!message || this.loading || this.currentChat === null || this.inputElement.disabled) return;
        this.clearDeleteArm();
        this.closeReactionPicker();
        this.replyTo = this.normalizeReply({
            chat: this.currentChat, id, author: message.username || (message.own ? 'Вы' : `Пользователь ${message.user_id || ''}`),
            preview: this.messagePreview(message)
        });
        this.renderReplyComposer();
        this.inputElement.focus({ preventScroll: true });
        void this.saveLocalState();
    }

    cancelReply(focus = true) {
        this.replyTo = null;
        this.renderReplyComposer();
        if (focus && !this.destroyed) this.inputElement.focus({ preventScroll: true });
        void this.saveLocalState();
    }

    handleReplyLink(event) {
        const link = event.target.closest('.chat-reply-preview');
        if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
        event.preventDefault();
        void this.jumpToMessage(Number(link.dataset.replyChat), Number(link.dataset.replyId));
    }

    async ensureMessage(chat, id, valid) {
        const bucket = this.getSearchBucket(chat);
        const lookup = () => {
            if (bucket.deleted.has(id) || this.deletedIds.has(id)) return null;
            const message = this.messages.get(id) || bucket.messages.get(id);
            return message && !this.isPinMessage(message) ? message : null;
        };
        let message = lookup();
        if (message?.type === 'image' && !this.findMessageNode(id)?.closest('.chat-album-grid')) {
            for (const candidate of bucket.messages.values()) {
                if (candidate.type === 'text' && this.parseAlbum(candidate.body)?.ids.includes(id)) {
                    this.upsertMessage(candidate);
                    break;
                }
            }
        }
        if (message || bucket.deleted.has(id)) return message;
        let cursor = 0;
        while (!this.destroyed && valid()) {
            const response = await this.context.api('poll', { chat, lastId: cursor });
            if (this.destroyed || !valid()) return null;
            for (const event of response.messages || []) this.indexEvent(chat, event, bucket);
            message = lookup();
            if (message || bucket.deleted.has(id)) return message;
            const next = Number(response.last_message_id ?? cursor);
            if (!response.has_more || next <= cursor) break;
            cursor = next;
        }
        return lookup();
    }

    async jumpToMessage(chat, id) {
        if (this.destroyed || !POSITIVE_ID(id)) return false;
        if (!this.chats.some(entry => Number(entry.chat) === chat)) {
            this.notify('Чат недоступен');
            return false;
        }
        this.closeReactionPicker();
        if (chat !== this.currentChat && !await this.switchChat(chat)) return false;
        if (this.loading || this.destroyed) return false;
        const jump = ++this.jumpVersion;
        const view = this.viewVersion;
        const valid = () => jump === this.jumpVersion && view === this.viewVersion && chat === this.currentChat;
        try {
            const message = await this.ensureMessage(chat, id, valid);
            if (this.destroyed || !valid()) return false;
            if (!message || this.deletedIds.has(id)) {
                this.notify('Исходное сообщение удалено или недоступно');
                return false;
            }
            if (!this.findMessageNode(id)) this.upsertMessage(message);
            if (message.type === 'text') {
                const album = this.parseAlbum(message.body);
                const bucket = this.searchIndex.get(chat);
                for (const imageId of album?.ids || []) {
                    const cached = bucket?.messages.get(imageId);
                    if (cached && cached.type === 'image' && !this.findMessageNode(imageId)) this.upsertMessage(cached);
                }
            }
            this.syncAlbums();
            const node = this.findMessageNode(id);
            if (!node) return false;
            this.context.setParams({ chat, message: id });
            requestAnimationFrame(() => {
                if (!valid() || this.destroyed || !node.isConnected) return;
                const text = node.querySelector('.chat-message-text');
                if (text) text.dataset.searchOpen = 'true';
                const fold = node.querySelector('.chat-text-fold');
                if (fold) fold.open = true;
                node.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion:reduce)').matches ? 'auto' : 'smooth' });
                this.windowElement.querySelectorAll('.search-highlight').forEach(entry => entry.classList.remove('search-highlight'));
                node.classList.add('search-highlight');
                clearTimeout(this.highlightTimer);
                this.highlightTimer = setTimeout(() => node.classList.remove('search-highlight'), 3000);
            });
            return true;
        } catch (error) {
            if (!this.destroyed && valid()) this.notify(error.message || 'Не удалось загрузить сообщение');
            return false;
        }
    }

    safeColor(value) {
        return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : '#334155';
    }

    contrastColor(hex) {
        const value = this.safeColor(hex).slice(1);
        const [red, green, blue] = value.match(/../g).map(part => parseInt(part, 16));
        return (red * 299 + green * 587 + blue * 114) / 1000 > 155 ? '#18212c' : '#f3f6fa';
    }

    chatTitle(chat) {
        const raw = chat.firstMessage;
        const text = this.parsePin(raw) ? '' : this.messageParts({ type: 'text', body: raw }).text;
        return text.replace(/\s+/g, ' ').trim() || (Number(chat.chat) === this.generalChatId ? 'Общий чат' : `Чат ${chat.chat}`);
    }

    renderTabs() {
        if (this.destroyed) return;
        const left = this.tabsElement.scrollLeft;
        const focused = this.tabsElement.contains(document.activeElement) ? document.activeElement.dataset.chat : null;
        const chats = [...this.chats].sort((a, b) => Number(Number(b.chat) === this.generalChatId) - Number(Number(a.chat) === this.generalChatId));
        const fragment = document.createDocumentFragment();
        for (const chat of chats) {
            const id = Number(chat.chat);
            const active = id === this.currentChat;
            const tab = this.actionButton(`chat-tab${active ? ' active' : ''}${id === this.generalChatId ? ' general-chat' : ''}`, '');
            const title = this.chatTitle(chat);
            const participants = (chat.participants || []).map(user => user.username || `Пользователь ${user.id}`).join(', ');
            const color = this.safeColor(chat.color);
            tab.title = title + (participants ? ` — ${participants}` : '');
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(active));
            tab.dataset.chat = String(id);
            tab.style.setProperty('--chat-tab-color', color);
            tab.style.setProperty('--chat-tab-text', this.contrastColor(color));
            tab.append(element('span', 'chat-tab-label', title));
            if (this.unread[String(id)]) {
                const dot = element('span', 'chat-tab-unread', '●');
                dot.setAttribute('aria-label', 'Есть непрочитанные сообщения');
                tab.append(dot);
            }
            if (active && id !== this.generalChatId) {
                const close = element('span', 'chat-tab-close', '×');
                close.title = 'Покинуть чат';
                tab.append(close);
            }
            fragment.append(tab);
        }
        this.tabsElement.replaceChildren(fragment);
        this.tabsElement.scrollLeft = left;
        if (focused != null) this.tabsElement.querySelector(`[data-chat="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    }

    getSearchBucket(chatId) {
        const id = Number(chatId);
        if (!this.searchIndex.has(id)) this.searchIndex.set(id, { messages: new Map(), deleted: new Set(), cursor: 0, loaded: false });
        return this.searchIndex.get(id);
    }

    indexEvent(chatId, event, target = null) {
        if (chatId === null || !event) return;
        const bucket = target || this.getSearchBucket(chatId);
        if (event.type === 'delete') {
            const id = Number(event.body);
            if (!POSITIVE_ID(id)) return;
            bucket.deleted.add(id);
            bucket.messages.delete(id);
        } else if (event.type === 'edit') {
            if (event.message) this.indexEvent(chatId, event.message, bucket);
        } else if (event.type === 'reaction') {
            const message = bucket.messages.get(Number(event.message_id));
            if (message && Number(event.reaction_version || 0) >= Number(message.reaction_version || 0)) {
                Object.assign(message, { reactions: event.reactions || [], reaction_version: Number(event.reaction_version || 0) });
            }
        } else if (MESSAGE_TYPES.has(event.type)) {
            const id = Number(event.id);
            if (!POSITIVE_ID(id) || bucket.deleted.has(id)) return;
            const previous = bucket.messages.get(id);
            if (previous && Number(previous.revision || 0) > Number(event.revision || 0)) return;
            const next = { ...previous, ...event };
            if (previous && Number(previous.reaction_version || 0) > Number(event.reaction_version || 0)) {
                next.reactions = previous.reactions;
                next.reaction_version = previous.reaction_version;
            }
            bucket.messages.set(id, next);
        }
        if (Number(chatId) === this.currentChat) this.schedulePins();
    }

    renderHistory(messages) {
        this.clearDeleteArm();
        this.closeReactionPicker();
        this.messages.clear();
        this.pendingNodes.clear();
        this.deletedIds.clear();
        this.reactionStates.clear();
        this.windowElement.replaceChildren();
        this.renderingHistory = true;
        try {
            for (const message of messages) this.applyMessage(message);
        } finally {
            this.renderingHistory = false;
        }
        this.syncAlbums();
        this.refreshPins();
        this.scheduleFolds();
        this.scrollToBottom();
    }

    findMessageNode(id) {
        if (!POSITIVE_ID(Number(id))) return null;
        return this.windowElement.querySelector(`.chat-message[data-id="${Number(id)}"]`);
    }

    insertMessageNode(node) {
        const id = Number(node.dataset.id);
        const following = [...this.windowElement.children].find(child =>
            child.matches('.chat-message.pending') || (child.matches('.chat-message[data-id]') && Number(child.dataset.id) > id)
        );
        this.windowElement.insertBefore(node, following || null);
    }

    removePendingNode(clientId) {
        this.pendingNodes.get(clientId)?.remove();
        this.pendingNodes.delete(clientId);
    }

    rememberReactionState(id, value) {
        const next = {
            reactions: Array.isArray(value?.reactions) ? value.reactions.filter(item => item && this.availableReactions.includes(item.emoji) && Number(item.count) > 0) : [],
            reaction_version: Number(value?.reaction_version || 0)
        };
        const old = this.reactionStates.get(id);
        if (old && old.reaction_version > next.reaction_version) return old;
        this.reactionStates.set(id, next);
        return next;
    }

    applyReactionState(id, value) {
        if (!POSITIVE_ID(id) || this.deletedIds.has(id)) return;
        const reaction = this.rememberReactionState(id, value);
        const message = this.messages.get(id);
        if (!message) return;
        Object.assign(message, reaction);
        const node = this.findMessageNode(id);
        if (node) this.renderMessageReactions(node, message);
    }

    applyMessage(message) {
        if (!message || this.destroyed) return;
        this.indexEvent(this.currentChat, message);
        if (message.type === 'delete') {
            const id = Number(message.body);
            if (!POSITIVE_ID(id)) return;
            this.deletedIds.add(id);
            const node = this.findMessageNode(id);
            if (node) {
                this.releaseAlbum(node);
                node.remove();
            }
            this.messages.delete(id);
            this.reactionStates.delete(id);
            if (this.reactionPickerId === id) this.closeReactionPicker();
            if (this.editing?.id === id) {
                this.editing = null;
                this.notify('Редактируемое сообщение удалено');
            }
            if (this.deleteArmed?.id === id) this.clearDeleteArm();
            this.invalidateAttachment(id);
            this.refreshReplyReferences(id);
            this.scheduleFolds();
            this.schedulePins();
            return;
        }
        if (message.type === 'reaction') return this.applyReactionState(Number(message.message_id), message);
        if (message.type === 'edit') {
            if (message.message) this.upsertMessage(message.message);
            return;
        }
        if (!MESSAGE_TYPES.has(message.type)) return;
        if (message.client_id) this.removePendingNode(message.client_id);
        this.upsertMessage(message);
    }

    upsertMessage(message) {
        const id = Number(message.id);
        if (!POSITIVE_ID(id) || this.deletedIds.has(id)) return;
        this.indexEvent(this.currentChat, message);
        const previous = this.messages.get(id);
        const existing = this.findMessageNode(id);
        const reactions = this.rememberReactionState(id, message);
        const incoming = previous && Number(previous.revision || 0) > Number(message.revision || 0)
            ? { ...previous, ...reactions } : { ...previous, ...message, ...reactions };
        if (this.isPinMessage(incoming)) {
            if (existing) {
                this.releaseAlbum(existing);
                existing.remove();
            }
            this.messages.delete(id);
            this.scheduleFolds();
            this.schedulePins();
            return;
        }
        this.messages.set(id, incoming);
        const bodyChanged = !previous || ['revision', 'body', 'type', 'edited_at', 'username', 'own', 'can_edit', 'can_delete', 'can_react', 'file_name']
            .some(key => previous[key] !== incoming[key]);
        if (existing && (!bodyChanged || this.editing?.id === id)) {
            this.renderMessageReactions(existing, incoming);
            if (bodyChanged) this.refreshReplyReferences(id);
            return;
        }
        if (this.deleteArmed?.id === id) this.clearDeleteArm();
        const node = this.createMessageNode(incoming);
        if (existing) {
            const open = existing.querySelector('.chat-text-fold')?.open;
            this.releaseAlbum(existing);
            if (existing.classList.contains('chat-album-item')) {
                existing.remove();
                this.insertMessageNode(node);
            } else {
                existing.replaceWith(node);
            }
            const fold = node.querySelector('.chat-text-fold');
            if (fold && open) fold.open = true;
        } else if (this.renderingHistory) {
            this.windowElement.append(node);
        } else {
            this.insertMessageNode(node);
        }
        if (this.reactionPickerId === id) this.renderReactionPicker(incoming);
        if (!this.renderingHistory) this.refreshReplyReferences(id);
        this.scheduleFolds();
        this.schedulePins();
    }

    createMessageNode(message, pending = false) {
        const own = message.own === true;
        const ai = Number(message.user_id) === 0 || message.username === 'Ai';
        const id = Number(message.id);
        const pinned = !pending && this.pins.some(pin => pin.id === id);
        const node = element('article', `chat-message ${own ? 'chat-message-own' : ai ? 'chat-message-ai' : 'chat-message-other'}${pending ? ' pending' : ''}${pinned ? ' is-pinned' : ''}`);
        if (!pending) node.dataset.id = String(id);
        if (message.client_id) node.dataset.clientId = message.client_id;
        const header = element('header', 'chat-message-header');
        const date = datestring(message.created);
        const author = element('span', '', message.username || (own ? 'Вы' : `Пользователь ${message.user_id || ''}`));
        const time = element('time');
        if (!Number.isNaN(date.getTime())) {
            time.dateTime = date.toISOString();
            time.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        if (message.edited_at) time.append(' · изменено');
        header.append(author, time);
        const content = element('div', 'chat-message-content');
        node.append(header, content);
        if (message.type === 'text') this.renderMessageText(content, message);
        else this.renderAttachment(content, node, message);
        if (pending) return node;
        const reactions = element('div', 'chat-reactions');
        const actions = element('div', 'chat-message-actions');
        actions.append(this.iconButton('chat-message-reply', 'reply', 'Ответить на сообщение'));
        const pin = this.iconButton('chat-message-pin', 'pin', pinned ? 'Открепить сообщение' : 'Закрепить сообщение');
        pin.setAttribute('aria-pressed', String(pinned));
        pin.setAttribute('aria-haspopup', 'dialog');
        actions.append(pin);
        if (message.can_react) {
            const react = this.iconButton('chat-message-react', 'react', 'Добавить реакцию');
            react.setAttribute('aria-haspopup', 'dialog');
            actions.append(react);
        }
        if (message.type === 'text') actions.append(this.iconButton('chat-message-copy', 'copy', 'Копировать текст'));
        if (message.can_edit) actions.append(this.iconButton('chat-message-edit', 'edit', 'Редактировать сообщение'));
        if (message.can_delete) actions.append(this.iconButton('chat-message-delete', 'delete', 'Нажмите дважды для удаления'));
        node.append(reactions, actions);
        this.renderMessageReactions(node, message, false);
        return node;
    }

    renderMessageText(content, message, editing = false) {
        const parsed = this.messageParts(message);
        const reply = this.createReplyPreview(parsed.reply);
        if (reply) content.append(reply);
        if (parsed.album) {
            const grid = element('div', 'chat-album-grid');
            grid.setAttribute('aria-label', 'Изображения поста');
            content.append(grid);
        }
        if (!editing && (parsed.text || !parsed.album)) {
            const text = element('div', `chat-message-text${parsed.album ? ' chat-album-caption' : ''}`);
            this.appendMarkdown(text, parsed.text);
            content.append(text);
            if (parsed.text.split('\n').length > 10) this.foldText(text);
        }
        return parsed;
    }

    albumGrid(node) {
        return node?.querySelector(':scope > .chat-message-content > .chat-album-grid') || null;
    }

    albumOwner(node) {
        return node?.parentElement?.matches('.chat-album-grid') ? node.parentElement.closest('.chat-message') : null;
    }

    releaseAlbum(node) {
        const grid = this.albumGrid(node);
        if (!grid) return;
        for (const tile of [...grid.children]) {
            this.configureAlbumTile(tile, false);
            this.insertMessageNode(tile);
        }
    }

    setTileControls(node, active) {
        const toggle = node.querySelector(':scope > .chat-album-toggle');
        const actions = node.querySelector(':scope > .chat-message-actions');
        if (!toggle || !actions) return;
        node.dataset.controlsOpen = String(active);
        toggle.setAttribute('aria-expanded', String(active));
        actions.hidden = !active;
        if (!active && this.reactionPickerId === Number(node.dataset.id)) this.closeReactionPicker();
        this.schedulePickerPosition();
    }

    configureAlbumTile(node, grouped) {
        if (node.classList.contains('chat-album-item') === grouped) return;
        node.classList.toggle('chat-album-item', grouped);
        const header = node.querySelector(':scope > .chat-message-header');
        const content = node.querySelector(':scope > .chat-message-content');
        const actions = node.querySelector(':scope > .chat-message-actions');
        const reactions = node.querySelector(':scope > .chat-reactions');
        if (header) header.hidden = grouped;
        if (!grouped) {
            node.removeAttribute('style');
            delete node.dataset.controlsOpen;
            node.querySelector(':scope > .chat-album-toggle')?.remove();
            for (const child of [content, actions, reactions]) child?.removeAttribute('style');
            if (actions) actions.hidden = false;
            return;
        }
        Object.assign(node.style, { display: 'grid', maxWidth: 'none', minWidth: '0', alignSelf: 'stretch', padding: '0', borderRadius: '0', boxShadow: 'none', overflow: 'hidden' });
        if (content) Object.assign(content.style, { width: '100%', height: '100%', display: 'grid', placeItems: 'center' });
        if (actions) {
            Object.assign(actions.style, {
                position: 'absolute', top: '26px', right: '3px', zIndex: '2', margin: '0',
                padding: '2px', borderRadius: '5px', background: 'rgba(232,237,242,.95)', opacity: '1'
            });
            const toggle = this.iconButton('chat-album-toggle', 'menu', 'Действия с изображением');
            Object.assign(toggle.style, {
                position: 'absolute', top: '3px', right: '3px', zIndex: '2', width: '23px', height: '23px',
                display: 'grid', placeItems: 'center', padding: '3px', color: '#eef2f6',
                border: '0', borderRadius: '5px', background: 'rgba(29,42,55,.8)'
            });
            toggle.onclick = event => {
                event.stopPropagation();
                this.setTileControls(node, actions.hidden);
            };
            node.append(toggle);
            this.setTileControls(node, false);
        }
        if (reactions) Object.assign(reactions.style, { position: 'absolute', left: '3px', bottom: '3px', zIndex: '1', margin: '0' });
    }

    syncAlbums() {
        if (this.destroyed) return;
        const owners = new Map();
        const nodes = new Map([...this.windowElement.querySelectorAll('.chat-message[data-id]')]
            .map(node => [Number(node.dataset.id), node]));
        const posts = [...this.windowElement.children].filter(node => this.albumGrid(node));
        for (const post of posts) {
            const parent = this.messages.get(Number(post.dataset.id));
            const album = parent?.type === 'text' && this.parseAlbum(parent.body);
            if (!album || (album.chat !== null && album.chat !== this.currentChat)) continue;
            const grid = this.albumGrid(post);
            for (const id of album.ids) {
                const image = this.messages.get(id);
                if (!image || image.type !== 'image' || id >= Number(parent.id) || !nodes.has(id) || owners.has(id)) continue;
                if (!Number.isInteger(Number(parent.user_id)) || Number(parent.user_id) !== Number(image.user_id)) continue;
                owners.set(id, grid);
            }
        }
        for (const post of posts) {
            const grid = this.albumGrid(post);
            for (const tile of [...grid.children]) {
                if (owners.get(Number(tile.dataset.id)) === grid) continue;
                this.configureAlbumTile(tile, false);
                this.insertMessageNode(tile);
            }
            const parent = this.messages.get(Number(post.dataset.id));
            const album = parent && this.parseAlbum(parent.body);
            const ids = (album?.ids || []).filter(id => owners.get(id) === grid);
            ids.forEach((id, index) => {
                const tile = nodes.get(id);
                if (grid.children[index] !== tile) grid.insertBefore(tile, grid.children[index] || null);
                this.configureAlbumTile(tile, true);
            });
            grid.hidden = ids.length === 0;
        }
    }

    invalidateAttachment(id) {
        const cached = this.attachmentImages?.get(id);
        this.attachmentImages?.delete(id);
        if (cached?.url && this.lightboxImage.src !== cached.url) {
            URL.revokeObjectURL(cached.url);
            this.objectUrls.delete(cached.url);
        }
    }

    async loadAttachmentImage(id, chat) {
        this.attachmentImages ||= new Map();
        let entry = this.attachmentImages.get(id);
        if (entry?.chat === chat) return entry.promise;
        entry = { chat, url: null, promise: null };
        entry.promise = (async () => {
            let cached;
            try {
                cached = await this.local.cachedFile(id);
            } catch (error) {
                attachmentError('Не удалось прочитать локальное изображение', error, { id, chat });
            }
            const file = Number(cached?.chatId) === chat && cached.blob instanceof Blob && cached.blob.size
                ? cached : await this.local.file(id, chat);
            if (!(file.blob instanceof Blob) || !file.blob.size) throw makeError('Некорректное содержимое изображения');
            if (this.destroyed || this.attachmentImages.get(id) !== entry) return null;
            entry.url = this.rememberObjectUrl(file.blob);
            return { ...file, url: entry.url };
        })().catch(error => {
            if (this.attachmentImages.get(id) === entry) this.attachmentImages.delete(id);
            throw error;
        });
        this.attachmentImages.set(id, entry);
        return entry.promise;
    }

    renderAttachment(content, node, message) {
        const chat = this.currentChat;
        const id = Number(message.id);
        const name = message.file_name || `attachment-${id}`;
        const status = element('small');
        if (message.type !== 'image') {
            status.textContent = name;
            content.append(status);
            return;
        }
        status.textContent = 'Загрузка изображения…';
        content.append(status);
        void this.loadAttachmentImage(id, chat).then(file => {
            if (!file || this.destroyed || !node.isConnected) return;
            const image = element('img', 'chat-message-image');
            image.alt = message.file_name || 'Изображение';
            image.decoding = 'async';
            image.onload = () => {
                if (this.destroyed || !node.isConnected || this.currentChat !== chat) return;
                const bottom = this.nearBottom();
                content.prepend(image);
                status.textContent = file.notSaved ? 'Изображение не сохранено для офлайн.' : '';
                status.hidden = !file.notSaved;
                if (bottom) this.scrollToBottom();
                this.schedulePickerPosition();
            };
            image.onerror = error => {
                if (this.destroyed || !node.isConnected) return;
                status.textContent = 'Не удалось отобразить изображение.';
                attachmentError('Ошибка отображения изображения', error, { id, chat, name });
            };
            image.src = file.url;
        }).catch(error => {
            if (this.destroyed || !node.isConnected) return;
            status.textContent = navigator.onLine ? error.message || 'Не удалось загрузить изображение.' : 'Изображение ещё не сохранено в браузере.';
            attachmentError('Не удалось загрузить изображение', error, { id, chat, name });
        });
    }

    renderPendingMessages() {
        if (this.destroyed) return;
        for (const node of this.pendingNodes.values()) node.remove();
        this.pendingNodes.clear();
        const delivered = new Set([...this.messages.values()].map(message => message.client_id));
        for (const item of this.outbox) {
            if (item.chat !== this.currentChat || !['send', 'failed'].includes(item.phase) || delivered.has(item.clientId)) continue;
            const node = this.createMessageNode({
                client_id: item.clientId, own: true, username: this.context.bootstrap.user?.username || 'Вы',
                type: 'text', body: item.text, created: new Date(item.createdAt).toISOString()
            }, true);
            node.append(element('small', 'chat-message-state', item.phase === 'failed'
                ? 'Не отправлено' : navigator.onLine ? 'Ожидает отправки…' : 'Ожидает подключения'));
            if (item.phase === 'failed') {
                const actions = element('div', 'chat-message-actions');
                actions.append(this.actionButton('chat-pending-retry', 'Повторить'), this.actionButton('chat-pending-cancel', 'Убрать'));
                node.append(actions);
            }
            this.windowElement.append(node);
            this.pendingNodes.set(item.clientId, node);
        }
        this.scheduleFolds();
    }

    async copyMessage(id, button) {
        const text = this.messageParts(this.messages.get(id)).text;
        try {
            if (!navigator.clipboard?.writeText) throw makeError('Копирование недоступно');
            await navigator.clipboard.writeText(text);
            if (this.destroyed || !button.isConnected) return;
            this.setButtonIcon(button, 'check', 'Скопировано');
            setTimeout(() => {
                if (!this.destroyed && button.isConnected) this.setButtonIcon(button, 'copy', 'Копировать текст');
            }, 1600);
        } catch {
            this.notify('Не удалось скопировать текст');
        }
    }

    startEdit(id) {
        const message = this.messages.get(id);
        const node = this.findMessageNode(id);
        if (!message?.can_edit || message.type !== 'text' || !node || this.editing || this.loading) return;
        this.clearDeleteArm();
        this.closeReactionPicker();
        this.releaseAlbum(node);
        const content = node.querySelector(':scope > .chat-message-content');
        content.replaceChildren();
        const parsed = this.renderMessageText(content, message, true);
        this.editing = { id, chat: this.currentChat, revision: Number(message.revision || 0), reply: parsed.reply, album: parsed.album, saving: false };
        node.classList.add('editing');
        node.querySelector(':scope > .chat-message-actions').hidden = true;
        const textarea = Object.assign(element('textarea', 'chat-edit-textarea'), {
            maxLength: 50000, value: parsed.text, rows: Math.max(3, Math.min(12, parsed.text.split('\n').length + 1))
        });
        const controls = element('div', 'chat-edit-controls');
        controls.append(this.actionButton('chat-edit-save', 'Сохранить'), this.actionButton('chat-edit-cancel', 'Отмена'));
        content.append(textarea, controls, element('small', 'chat-edit-hint', 'Ctrl+Enter — сохранить, Esc — отменить'));
        this.syncAlbums();
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }

    replaceEditedNode(id) {
        const previous = this.findMessageNode(id);
        const message = this.messages.get(id);
        if (previous && message) {
            this.releaseAlbum(previous);
            previous.replaceWith(this.createMessageNode(message));
        }
        this.scheduleFolds();
        this.schedulePins();
    }

    cancelEdit() {
        if (!this.editing || this.editing.saving) return;
        const { id } = this.editing;
        this.editing = null;
        this.replaceEditedNode(id);
    }

    async saveEdit() {
        const edit = this.editing;
        if (!edit || edit.saving) return;
        const node = this.findMessageNode(edit.id);
        const content = node?.querySelector(':scope > .chat-message-content');
        const textarea = content?.querySelector('.chat-edit-textarea');
        if (!textarea) return;
        const raw = textarea.value;
        if (!raw.trim() && !edit.album) return this.notify('Сообщение не может быть пустым');
        if (this.isReservedText(raw)) return this.notify('Этот метатег зарезервирован для служебных сообщений');
        const body = this.composeReply(raw, edit.reply);
        const text = edit.album ? `${edit.album.prefix}\n${body}` : body;
        if ([...text].length > 50000) return this.notify('Сообщение вместе с метаданными слишком длинное');
        const controls = content.querySelectorAll(':scope > textarea,:scope > .chat-edit-controls > button');
        edit.saving = true;
        controls.forEach(control => { control.disabled = true; });
        try {
            const response = await this.context.api('editMessage', { chat: edit.chat, id: edit.id, text, revision: edit.revision });
            if (this.destroyed) return;
            if (this.editing === edit) this.editing = null;
            if (this.currentChat === edit.chat) {
                if (response.message) this.upsertMessage(response.message);
                if (this.findMessageNode(edit.id)?.classList.contains('editing')) this.replaceEditedNode(edit.id);
                this.refreshReplyReferences(edit.id);
            }
            this.applyMeta(response.chat);
            void this.pollCurrentChat();
        } catch (error) {
            if (this.destroyed || this.editing !== edit) return;
            edit.saving = false;
            controls.forEach(control => { control.disabled = false; });
            this.notify(error.message || 'Не удалось сохранить сообщение');
        }
    }

    clearDeleteArm() {
        clearTimeout(this.deleteTimer);
        const button = this.deleteArmed?.button;
        if (button?.isConnected) {
            button.classList.remove('armed');
            this.setButtonIcon(button, 'delete', 'Нажмите дважды для удаления');
        }
        this.deleteArmed = null;
    }

    handleDeleteClick(id, button) {
        if (!this.messages.get(id)?.can_delete || button.disabled) return;
        if (this.deleteArmed?.id === id && this.deleteArmed.button === button && Date.now() < this.deleteArmed.expires) {
            this.clearDeleteArm();
            void this.deleteMessage(id, button);
            return;
        }
        this.clearDeleteArm();
        this.closeReactionPicker();
        this.deleteArmed = { id, button, expires: Date.now() + 4000 };
        button.classList.add('armed');
        this.setButtonIcon(button, 'warning', 'Нажмите ещё раз для удаления');
        this.deleteTimer = setTimeout(() => this.clearDeleteArm(), 4000);
    }

    async deleteMessage(id, button) {
        const chat = this.currentChat;
        button.disabled = true;
        try {
            const response = await this.context.api('deleteMessage', { chat, id });
            if (this.destroyed) return;
            const event = { type: 'delete', body: String(id) };
            this.indexEvent(chat, event);
            if (this.currentChat === chat) this.applyMessage(event);
            this.applyMeta(response.chat);
            void this.pollCurrentChat();
        } catch (error) {
            if (!this.destroyed) {
                button.disabled = false;
                this.notify(error.message || 'Не удалось удалить сообщение');
            }
        }
    }

    renderMessageReactions(node, message, updatePicker = true) {
        const id = Number(message.id);
        const busy = this.reactionRequests.has(`${this.currentChat}:${id}`);
        const container = node.querySelector(':scope > .chat-reactions');
        if (container) {
            const buttons = [];
            for (const reaction of message.reactions || []) {
                const button = this.actionButton(`chat-reaction-chip${reaction.own ? ' own' : ''}`, '');
                button.disabled = busy || !message.can_react;
                button.dataset.reaction = reaction.emoji;
                button.setAttribute('aria-pressed', String(!!reaction.own));
                const users = (reaction.users || []).map(user => user.username || `Пользователь ${user.id}`).join(', ');
                button.title = `${reaction.emoji} · ${reaction.count}${users ? ` — ${users}` : ''}`;
                button.setAttribute('aria-label', button.title);
                button.append(element('span', 'chat-reaction-emoji', reaction.emoji), element('span', 'chat-reaction-count', reaction.count));
                buttons.push(button);
            }
            container.replaceChildren(...buttons);
        }
        const trigger = this.reactionTrigger(id, node);
        if (trigger) {
            trigger.disabled = busy;
            trigger.setAttribute('aria-expanded', String(this.reactionPickerId === id));
        }
        if (updatePicker && this.reactionPickerId === id) this.renderReactionPicker(message);
    }

    reactionTrigger(id, node = this.findMessageNode(id)) {
        return node?.querySelector(':scope > .chat-message-actions > .chat-message-react');
    }

    renderReactionPicker(message) {
        const id = Number(message.id);
        const trigger = this.reactionTrigger(id);
        if (this.reactionPickerId !== id || !message.can_react || !trigger?.getClientRects().length) {
            if (this.reactionPickerId === id) this.closeReactionPicker();
            return;
        }
        let picker = this.reactionPickerElement;
        const active = picker?.contains(document.activeElement) ? document.activeElement.dataset.reaction : null;
        if (!picker) {
            picker = element('div', 'chat-reaction-picker');
            picker.id = `chat-reaction-picker-${createId()}`;
            picker.setAttribute('role', 'dialog');
            picker.setAttribute('aria-label', 'Выберите реакцию');
            picker.style.visibility = 'hidden';
            this.reactionPickerElement = picker;
            document.body.append(picker);
            picker.onclick = event => {
                const button = event.target.closest('button[data-reaction]');
                if (button && !button.disabled) void this.setReaction(this.reactionPickerId, button.dataset.reaction);
            };
            picker.onkeydown = event => {
                const buttons = [...picker.querySelectorAll('button:not(:disabled)')];
                if (!buttons.length) return;
                const index = buttons.indexOf(document.activeElement);
                let next;
                if (['ArrowRight', 'ArrowDown'].includes(event.key)) next = buttons[(index + 1 + buttons.length) % buttons.length];
                else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) next = buttons[(index - 1 + buttons.length) % buttons.length];
                else if (event.key === 'Home') next = buttons[0];
                else if (event.key === 'End') next = buttons.at(-1);
                else if (event.key === 'Tab') {
                    this.closeReactionPicker(true);
                    return;
                }
                if (next) {
                    event.preventDefault();
                    next.focus({ preventScroll: true });
                }
            };
        }
        const buttons = this.availableReactions.map(emoji => {
            const own = (message.reactions || []).some(reaction => reaction.emoji === emoji && reaction.own);
            const button = this.actionButton(`chat-reaction-option${own ? ' own' : ''}`, emoji, `${own ? 'Убрать' : 'Добавить'} ${emoji}`);
            button.dataset.reaction = emoji;
            button.disabled = this.reactionRequests.has(`${this.currentChat}:${id}`);
            button.setAttribute('aria-pressed', String(own));
            button.setAttribute('aria-label', button.title);
            return button;
        });
        picker.replaceChildren(...buttons);
        trigger.setAttribute('aria-controls', picker.id);
        trigger.setAttribute('aria-expanded', 'true');
        this.positionReactionPicker();
        if (active) buttons.find(button => button.dataset.reaction === active)?.focus({ preventScroll: true });
    }

    schedulePickerPosition() {
        if (this.destroyed || !this.reactionPickerElement || this.pickerFrame !== null) return;
        this.pickerFrame = requestAnimationFrame(() => {
            this.pickerFrame = null;
            this.positionReactionPicker();
        });
    }

    positionReactionPicker() {
        const picker = this.reactionPickerElement;
        if (!picker || this.destroyed) return;
        const trigger = this.reactionTrigger(this.reactionPickerId);
        if (!trigger?.getClientRects().length) return this.closeReactionPicker();
        const rect = trigger.getBoundingClientRect();
        const area = this.windowElement.getBoundingClientRect();
        const viewport = window.visualViewport;
        const x = viewport?.offsetLeft || 0;
        const y = viewport?.offsetTop || 0;
        const width = viewport?.width || document.documentElement.clientWidth;
        const height = viewport?.height || innerHeight;
        const leftEdge = x + 8;
        const rightEdge = x + width - 8;
        const topEdge = y + 8;
        const bottomEdge = y + height - 8;
        if (rect.bottom <= Math.max(area.top, topEdge) || rect.top >= Math.min(area.bottom, bottomEdge) || rect.right <= leftEdge || rect.left >= rightEdge) {
            this.closeReactionPicker();
            return;
        }
        picker.style.maxWidth = `${Math.max(0, width - 16)}px`;
        picker.style.maxHeight = `${Math.max(0, height - 16)}px`;
        const box = picker.getBoundingClientRect();
        const above = rect.top - 8 - topEdge >= box.height || rect.top - topEdge >= bottomEdge - rect.bottom;
        const left = Math.max(leftEdge, Math.min(rect.left + (rect.width - box.width) / 2, rightEdge - box.width));
        const top = Math.max(topEdge, Math.min(above ? rect.top - 8 - box.height : rect.bottom + 8, bottomEdge - box.height));
        Object.assign(picker.style, { left: `${Math.round(left)}px`, top: `${Math.round(top)}px`, visibility: 'visible' });
    }

    closeReactionPicker(restoreFocus = false) {
        const id = this.reactionPickerId;
        this.reactionPickerId = null;
        this.reactionPickerElement?.remove();
        this.reactionPickerElement = null;
        if (this.pickerFrame !== null) cancelAnimationFrame(this.pickerFrame);
        this.pickerFrame = null;
        const trigger = id === null ? null : this.reactionTrigger(id);
        trigger?.setAttribute('aria-expanded', 'false');
        trigger?.removeAttribute('aria-controls');
        if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
    }

    toggleReactionPicker(id) {
        const message = this.messages.get(id);
        if (!message?.can_react || this.loading || this.editing?.id === id) return;
        if (this.reactionPickerId === id) return this.closeReactionPicker(true);
        this.closeReactionPicker();
        this.clearDeleteArm();
        this.reactionPickerId = id;
        this.renderReactionPicker(message);
        this.reactionPickerElement?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    }

    async setReaction(id, emoji) {
        const message = this.messages.get(id);
        const chat = this.currentChat;
        const view = this.viewVersion;
        const key = `${chat}:${id}`;
        if (!message?.can_react || !this.availableReactions.includes(emoji) || chat === null || this.reactionRequests.has(key) || this.editing?.id === id) return;
        if (!navigator.onLine) return this.notify('Для изменения реакции нужно подключение');
        const active = !(message.reactions || []).some(reaction => reaction.emoji === emoji && reaction.own);
        this.closeReactionPicker(!!this.reactionPickerElement?.contains(document.activeElement));
        this.reactionRequests.add(key);
        const node = this.findMessageNode(id);
        if (node) this.renderMessageReactions(node, message);
        try {
            const response = await this.context.api('setReaction', { chat, id, emoji, active, clientId: createId() });
            this.indexEvent(chat, { ...response, type: 'reaction' });
            if (!this.destroyed && view === this.viewVersion) {
                this.applyReactionState(id, response);
                this.setConnection(true);
            }
        } catch (error) {
            if (!this.destroyed && view === this.viewVersion) this.notify(error.message || 'Не удалось изменить реакцию');
        } finally {
            this.reactionRequests.delete(key);
            if (!this.destroyed && view === this.viewVersion) {
                const current = this.messages.get(id);
                const currentNode = this.findMessageNode(id);
                if (current && currentNode) this.renderMessageReactions(currentNode, current);
                void this.pollCurrentChat();
            }
        }
    }

    makeModal(title, large = false) {
        const overlay = element('div', 'chat-modal-overlay');
        const modal = element('div', `chat-modal${large ? ' chat-search-modal' : ''}`);
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-label', title);
        modal.tabIndex = -1;
        const top = element('div', 'chat-search-top');
        const close = this.actionButton('chat-search-close', '×', 'Закрыть');
        close.setAttribute('aria-label', 'Закрыть');
        top.append(element('h3', '', title), close);
        modal.append(top);
        overlay.append(modal);
        return overlay;
    }

    mountModal(overlay, canClose = () => true, onClose = () => {}) {
        this.closeReactionPicker();
        this.clearDeleteArm();
        const previousFocus = document.activeElement;
        let closed = false;
        this.modal = overlay;
        document.body.append(overlay);
        const finish = restore => {
            if (closed) return true;
            closed = true;
            onClose();
            overlay.remove();
            if (this.modal === overlay) {
                this.modal = null;
                this.modalClose = null;
                this.modalDispose = null;
            }
            if (restore && !this.destroyed && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
            return true;
        };
        const close = () => closed || (canClose() ? finish(true) : false);
        this.modalClose = close;
        this.modalDispose = () => finish(false);
        overlay.onclick = event => {
            if (event.target === overlay) close();
        };
        return close;
    }

    openMenu() {
        if (this.destroyed || this.modal) return;
        const overlay = this.makeModal('Меню чата');
        overlay.querySelector('.chat-modal').append(this.menuContent);
        this.menuContent.hidden = false;
        this.menuElement.setAttribute('aria-expanded', 'true');
        const close = this.mountModal(overlay, () => !this.colorSaving, () => {
            this.menuContent.hidden = true;
            this.wrapper.append(this.menuContent);
            this.menuElement.setAttribute('aria-expanded', 'false');
        });
        overlay.querySelector('.chat-search-close').onclick = close;
		
		this.editMembersElement.hidden = !this.chats.some(
    chat => Number(chat.chat) === this.currentChat && chat.canEditMembers === true
);
        this.updateControls();
        (this.createElement.disabled ? overlay.querySelector('.chat-search-close') : this.createElement).focus({ preventScroll: true });
    }

    async openCreateDialog() {
        if (this.modal || this.destroyed || this.creatingDialog) return;
        this.creatingDialog = true;
        let response;
        try {
            response = await this.context.api('listUsers');
        } catch (error) {
            this.notify(error.message || 'Не удалось получить пользователей');
            return;
        } finally {
            this.creatingDialog = false;
        }
        if (this.destroyed || this.modal) return;
        const overlay = this.makeModal('Создать чат');
        overlay.querySelector('.chat-modal').insertAdjacentHTML('beforeend', `
            <p class="chat-create-hint">Первое сообщение используется как название вкладки. Без участников будет создан личный чат. Режим ИИ выбирается в меню чата.</p>
            <div class="chat-users-list"></div>
            <label class="chat-first-message">Первое сообщение — название чата<textarea rows="3" maxlength="50000" placeholder="Например: Заказ №125 — согласование"></textarea></label>
            <label class="chat-create-color">Цвет вкладки<input class="chat-new-color" type="color" value="#334155"></label>
            <div class="chat-modal-error" role="alert"></div>
            <div class="chat-modal-buttons"><button class="chat-create-confirm" type="button">Создать</button><button class="chat-create-cancel" type="button">Отмена</button></div>`);
        const users = overlay.querySelector('.chat-users-list');
        for (const user of response.users || []) {
            const id = Number(user.id);
            if (!POSITIVE_ID(id)) continue;
            const row = element('label', 'chat-user-row');
            row.append(Object.assign(element('input'), { type: 'checkbox', value: String(id) }), element('span', '', user.username || `Пользователь ${id}`));
            users.append(row);
        }
        const input = overlay.querySelector('textarea');
        const color = overlay.querySelector('.chat-new-color');
        const errorNode = overlay.querySelector('.chat-modal-error');
        let submitting = false;
        const close = this.mountModal(overlay, () => !submitting);
        overlay.querySelector('.chat-search-close').onclick = close;
        overlay.querySelector('.chat-create-cancel').onclick = close;
        overlay.querySelector('.chat-create-confirm').onclick = async () => {
            if (submitting) return;
            const contacts = [...users.querySelectorAll('input:checked')].map(control => Number(control.value));
            const firstMessage = input.value;
            if (this.isReservedText(firstMessage)) {
                errorNode.textContent = 'Этот метатег зарезервирован для служебных сообщений';
                return;
            }
            submitting = true;
            errorNode.textContent = '';
            const controls = overlay.querySelectorAll('button,input,textarea');
            controls.forEach(control => { control.disabled = true; });
            try {
                const result = await this.context.api('createChat', { contacts, firstMessage, color: color.value });
                if (this.destroyed) return;
                const id = Number(result.chat?.chat);
                if (!POSITIVE_ID(id)) throw makeError('Сервер вернул некорректный ID чата');
                if (!this.chats.some(chat => Number(chat.chat) === id)) this.chats.push({ ...result.chat, chat: id });
                submitting = false;
                close();
                await this.switchChat(id);
                this.renderTabs();
            } catch (error) {
                if (this.destroyed) return;
                submitting = false;
                errorNode.textContent = error.message || 'Не удалось создать чат';
                controls.forEach(control => { control.disabled = false; });
            }
        };
        input.focus();
    }

    schedulePins() {
        if (this.destroyed || this.pinFrame !== null) return;
        this.pinFrame = requestAnimationFrame(() => {
            this.pinFrame = null;
            this.refreshPins();
        });
    }

    refreshPins() {
        if (this.destroyed) return;
        const bucket = this.searchIndex.get(this.currentChat);
        const states = new Map();
        if (bucket) {
            const messages = [...bucket.messages.values()].sort((a, b) => Number(a.id) - Number(b.id));
            for (const message of messages) {
                if (!this.isPinMessage(message)) continue;
                const pin = this.parsePin(message.body);
                if (pin.chat !== this.currentChat || pin.id >= Number(message.id)) continue;
                states.set(pin.id, { ...pin, eventId: Number(message.id) });
            }
        }
        this.pins = [...states.values()].filter(pin => {
            const target = bucket?.messages.get(pin.id);
            return pin.active && target && !bucket.deleted.has(pin.id) && !this.isPinMessage(target);
        }).sort((a, b) => b.eventId - a.eventId);
        if (!this.pins.some(pin => pin.id === this.selectedPinId)) this.selectedPinId = this.pins[0]?.id ?? null;
        const ids = new Set(this.pins.map(pin => pin.id));
        for (const node of this.windowElement.querySelectorAll('.chat-message[data-id]')) {
            const active = ids.has(Number(node.dataset.id));
            node.classList.toggle('is-pinned', active);
            const button = node.querySelector(':scope > .chat-message-actions > .chat-message-pin');
            if (button) {
                button.setAttribute('aria-pressed', String(active));
                button.title = active ? 'Открепить сообщение' : 'Закрепить сообщение';
                button.setAttribute('aria-label', button.title);
            }
        }
        this.renderPinnedBar();
        this.renderPinsDialog();
    }

    renderPinnedBar() {
        this.pinnedElement.hidden = !this.pins.length;
        const index = this.pins.findIndex(pin => pin.id === this.selectedPinId);
        if (index < 0) return;
        const message = this.searchIndex.get(this.currentChat)?.messages.get(this.pins[index].id);
        this.pinnedTitle.textContent = `Закреплённое сообщение${this.pins.length > 1 ? ` · ${index + 1}/${this.pins.length}` : ''}`;
        this.pinnedText.textContent = `${message?.username || 'Сообщение'}: ${this.messagePreview(message)}`;
        this.pinnedList.textContent = `☷ ${this.pins.length}`;
        this.pinnedList.title = `Все закреплённые сообщения: ${this.pins.length}`;
    }

    openPinConfirm(id, active = !this.pins.some(pin => pin.id === id), returnToPins = false) {
        if (this.modal || this.destroyed || this.loading || this.currentChat === null) return;
        const chat = this.currentChat;
        const message = this.messages.get(id) || this.searchIndex.get(chat)?.messages.get(id);
        if (!message || this.isPinMessage(message)) return;
        const overlay = this.makeModal(active ? 'Закрепить сообщение?' : 'Открепить сообщение?');
        const modal = overlay.querySelector('.chat-modal');
        const hint = element('p', 'chat-create-hint', active
            ? 'Сообщение появится в панели закреплений у всех участников чата.'
            : 'Сообщение исчезнет из закреплений у всех участников, но останется в истории.');
        const preview = element('div', 'chat-pin-confirm-preview', `${message.username || 'Сообщение'}\n${this.messagePreview(message)}`);
        const errorNode = element('div', 'chat-modal-error');
        errorNode.setAttribute('role', 'alert');
        const controls = element('div', 'chat-modal-buttons');
        const confirm = this.actionButton(active ? 'chat-create-confirm' : 'chat-danger', active ? 'Закрепить' : 'Открепить');
        const cancel = this.actionButton('', 'Отмена');
        controls.append(cancel, confirm);
        modal.append(hint, preview, errorNode, controls);
        let submitting = false;
        const close = this.mountModal(overlay, () => !submitting);
        overlay.querySelector('.chat-search-close').onclick = close;
        const finish = () => {
            if (close() && returnToPins && this.currentChat === chat && !this.destroyed) this.openPinsDialog();
        };
        cancel.onclick = finish;
        confirm.onclick = async () => {
            if (submitting) return;
            submitting = true;
            errorNode.textContent = '';
            modal.querySelectorAll('button').forEach(button => { button.disabled = true; });
            try {
                await this.setPinned(chat, id, active);
                if (this.destroyed) return;
                submitting = false;
                finish();
            } catch (error) {
                if (this.destroyed) return;
                submitting = false;
                errorNode.textContent = error.message || 'Не удалось изменить закрепление';
                modal.querySelectorAll('button').forEach(button => { button.disabled = false; });
            }
        };
        confirm.focus();
    }

    async setPinned(chat, id, active) {
        if (!navigator.onLine) throw makeError('Для изменения закреплений требуется подключение');
        const key = `${chat}:${id}`;
        if (this.pinBusy.has(key)) throw makeError('Изменение закрепления уже выполняется');
        const bucket = this.searchIndex.get(chat);
        if (active && (!bucket?.messages.has(id) || bucket.deleted.has(id))) throw makeError('Сообщение удалено или недоступно');
        this.pinBusy.add(key);
        try {
            const response = await this.context.api('send', { chat, text: this.composePin(chat, id, active), clientId: createId() });
            if (!response.message) throw makeError('Сервер не подтвердил сохранение закрепления');
            if (this.destroyed) return;
            this.indexEvent(chat, response.message);
            if (this.currentChat === chat) {
                this.applyMessage(response.message);
                if (active) this.selectedPinId = id;
                this.refreshPins();
            }
            this.applyMeta(response.chat);
            this.setConnection(true);
            void this.pollCurrentChat();
        } finally {
            this.pinBusy.delete(key);
        }
    }

    openPinsDialog() {
        if (this.modal || this.destroyed || this.currentChat === null) return;
        this.refreshPins();
        const chat = this.currentChat;
        const overlay = this.makeModal('Закреплённые сообщения', true);
        const status = element('div', 'chat-search-status');
        const results = element('div', 'chat-search-results');
        overlay.querySelector('.chat-modal').append(status, results);
        this.pinDialogState = { chat, status, results, signature: null };
        const close = this.mountModal(overlay, () => true, () => { this.pinDialogState = null; });
        overlay.querySelector('.chat-search-close').onclick = close;
        results.onclick = event => {
            const remove = event.target.closest('[data-unpin]');
            if (remove) {
                close();
                this.openPinConfirm(Number(remove.dataset.unpin), false, true);
            } else {
                const result = event.target.closest('[data-pin-id]');
                if (!result) return;
                const id = Number(result.dataset.pinId);
                close();
                this.selectedPinId = id;
                this.renderPinnedBar();
                void this.jumpToMessage(chat, id);
            }
        };
        this.renderPinsDialog();
        overlay.querySelector('.chat-search-close').focus();
    }

    renderPinsDialog() {
        const state = this.pinDialogState;
        if (!state || state.chat !== this.currentChat) return;
        const bucket = this.searchIndex.get(state.chat);
        const signature = JSON.stringify(this.pins.map(pin => [pin.id, pin.eventId, bucket?.messages.get(pin.id)?.revision]));
        if (state.signature === signature) return;
        state.signature = signature;
        state.status.textContent = `Закреплено сообщений: ${this.pins.length}`;
        state.results.replaceChildren();
        if (!this.pins.length) {
            state.results.append(element('div', 'chat-search-empty', 'Нет закреплённых сообщений. Используйте кнопку 📌 под сообщением.'));
            return;
        }
        for (const pin of this.pins) {
            const message = bucket?.messages.get(pin.id);
            if (!message) continue;
            const row = element('div', 'chat-pin-row');
            const result = this.actionButton('chat-search-result', '');
            result.dataset.pinId = String(pin.id);
            result.append(
                element('span', 'chat-search-result-title', message.username || 'Сообщение'),
                element('span', 'chat-search-result-meta', this.formatDate(message.created)),
                element('span', 'chat-search-result-text', this.messagePreview(message))
            );
            const remove = this.actionButton('chat-pin-remove', '');
            this.setButtonIcon(remove, 'unpin', 'Открепить сообщение');
            remove.dataset.unpin = String(pin.id);
            row.append(result, remove);
            state.results.append(row);
        }
    }

    decodeEntities(value) {
        const textarea = element('textarea');
        textarea.innerHTML = String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return textarea.value;
    }

    appendLinkedText(container, value) {
        const text = String(value ?? '');
        let position = 0;
        for (const match of text.matchAll(/(?:https?:\/\/|www\.)[^\s<>"`]+/giu)) {
            let candidate = match[0];
            let suffix = '';
            container.append(text.slice(position, match.index));
            while (candidate) {
                const last = candidate.at(-1);
                const pair = { ')': '(', ']': '[', '}': '{' }[last];
                const unmatched = pair && candidate.split(last).length > candidate.split(pair).length;
                if (!/[.,!?;:…»”’]/u.test(last) && !unmatched) break;
                suffix = last + suffix;
                candidate = candidate.slice(0, -1);
            }
            const url = safeLink(candidate);
            if (url) {
                const link = createLink(url);
                link.textContent = candidate;
                container.append(link);
            } else container.append(candidate);
            if (suffix) container.append(suffix);
            position = match.index + match[0].length;
        }
        if (position < text.length) container.append(text.slice(position));
    }

    makeInlineSpoiler() {
        const button = this.actionButton('chat-inline-spoiler', '');
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-label', 'Показать спойлер');
        return button;
    }

    appendInline(container, value, depth = 0, allowLinks = true) {
        const text = String(value ?? '');
        if (depth > 12) return void container.append(text);
        let index = 0;
        let buffer = '';
        const flush = () => {
            if (!buffer) return;
            if (allowLinks) this.appendLinkedText(container, buffer);
            else container.append(buffer);
            buffer = '';
        };
        while (index < text.length) {
            const character = text[index];
            if (character === '\\' && /[\\`*_{}\[\]()#+\-.!|~>]/.test(text[index + 1] || '')) {
                buffer += text[index + 1];
                index += 2;
                continue;
            }
            if (character === '&') {
                const entity = text.slice(index).match(/^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/i);
                if (entity) {
                    buffer += this.decodeEntities(entity[0]);
                    index += entity[0].length;
                    continue;
                }
            }
            if (character === '`') {
                const marker = text.slice(index).match(/^`+/)[0];
                const end = text.indexOf(marker, index + marker.length);
                if (end !== -1) {
                    flush();
                    container.append(element('code', '', text.slice(index + marker.length, end)));
                    index = end + marker.length;
                    continue;
                }
            }
            if (character === '[' && allowLinks) {
                const match = text.slice(index).match(/^\[([^\]\n]+)\]\(\s*(<?[^\s<>]+>?)(?:\s+"([^"]*)")?\s*\)/);
                const url = match && safeLink(match[2].replace(/^<|>$/g, ''));
                if (url) {
                    flush();
                    const link = createLink(url);
                    if (match[3]) link.title = match[3];
                    this.appendInline(link, match[1], depth + 1, false);
                    container.append(link);
                    index += match[0].length;
                    continue;
                }
            }
            if (character === '<') {
                const fragment = text.slice(index);
                const auto = allowLinks && fragment.match(/^<(https?:\/\/[^<>\s]+)>/i);
                if (auto) {
                    flush();
                    this.appendLinkedText(container, auto[1]);
                    index += auto[0].length;
                    continue;
                }
                const br = fragment.match(/^<br\s*\/?>/i);
                if (br) {
                    buffer += '\n';
                    index += br[0].length;
                    continue;
                }
                const opening = fragment.match(/^<(b|strong|i|em|u|ins|s|strike|del|code|pre|a|tg-spoiler|span|blockquote)(\s[^<>]*?)?>/i);
                if (opening) {
                    const name = opening[1].toLowerCase();
                    const start = index + opening[0].length;
                    const pattern = new RegExp(`</${name}\\s*>`, 'ig');
                    pattern.lastIndex = start;
                    const closing = pattern.exec(text);
                    const attributes = opening[2] || '';
                    const spoiler = name === 'tg-spoiler' || (name === 'span' && /\bclass\s*=\s*["']tg-spoiler["']/i.test(attributes));
                    const href = name === 'a' && attributes.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
                    const url = allowLinks && href ? safeLink(this.decodeEntities(href[1] ?? href[2])) : '';
                    if (closing && (name !== 'span' || spoiler) && (name !== 'a' || url)) {
                        const tags = { b: 'strong', i: 'em', ins: 'u', s: 'del', strike: 'del', pre: 'code', blockquote: 'span' };
                        const node = spoiler ? this.makeInlineSpoiler() : name === 'a' ? createLink(url) : element(tags[name] || name);
                        const body = text.slice(start, closing.index);
                        flush();
                        if (name === 'code' || name === 'pre') node.textContent = this.decodeEntities(body.replace(/^<code(?:\s[^>]*)?>|<\/code>$/gi, ''));
                        else this.appendInline(node, body, depth + 1, allowLinks && name !== 'a' && !spoiler);
                        if (name === 'blockquote') Object.assign(node.style, { borderLeft: '2px solid #8497aa', paddingLeft: '.6em' });
                        container.append(node);
                        index = closing.index + closing[0].length;
                        continue;
                    }
                }
            }
            let formatted = false;
            if ('*_~|'.includes(character)) {
                for (const [marker, tag] of [['**', 'strong'], ['__', 'u'], ['~~', 'del'], ['||', 'spoiler'], ['*', 'em'], ['_', 'em'], ['~', 'del']]) {
                    if (!text.startsWith(marker, index)) continue;
                    if (marker.length === 1 && /[\p{L}\p{N}]/u.test(text[index - 1] || '') && /[\p{L}\p{N}]/u.test(text[index + 1] || '')) continue;
                    const start = index + marker.length;
                    let end = text.indexOf(marker, start);
                    while (end !== -1 && text[end - 1] === '\\') end = text.indexOf(marker, end + marker.length);
                    if (end <= start || /^\s|\s$/.test(text.slice(start, end))) continue;
                    flush();
                    const node = tag === 'spoiler' ? this.makeInlineSpoiler() : element(tag);
                    this.appendInline(node, text.slice(start, end), depth + 1, allowLinks && tag !== 'spoiler');
                    container.append(node);
                    index = end + marker.length;
                    formatted = true;
                    break;
                }
            }
            if (formatted) continue;
            buffer += character;
            index++;
        }
        flush();
    }

    appendMarkdown(container, value, depth = 0) {
        const text = String(value ?? '').replace(/\r\n?/g, '\n');
        if (depth > 8) return void container.append(element('p', '', text));
        const lines = text.split('\n');
        const divider = line => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line || '');
        const cells = line => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
        const horizontal = /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
        const listLine = /^\s*([-+*]|\d+[.)])\s+(.+)$/;
        const block = position => {
            const line = lines[position];
            return !line.trim() || /^\s{0,3}(?:`{3,}|~{3,})/.test(line) || /^#{1,6}\s+/.test(line) ||
                /^\s*>/.test(line) || listLine.test(line) || horizontal.test(line) || (line.includes('|') && divider(lines[position + 1]));
        };
        let index = 0;
        while (index < lines.length) {
            const line = lines[index++];
            if (!line.trim()) continue;
            const fence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)[^\n]*$/);
            if (fence) {
                const code = [];
                const end = new RegExp(`^\\s{0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
                while (index < lines.length && !end.test(lines[index])) code.push(lines[index++]);
                if (index < lines.length) index++;
                const wrapper = element('div', 'chat-code-block');
                if (fence[2]) wrapper.append(element('div', 'chat-code-language', fence[2].slice(0, 60)));
                const pre = element('pre');
                pre.append(element('code', '', code.join('\n')));
                wrapper.append(pre);
                container.append(wrapper);
                continue;
            }
            if (line.includes('|') && divider(lines[index])) {
                const headers = cells(line);
                const align = cells(lines[index++]).map(cell => cell.endsWith(':') ? cell.startsWith(':') ? 'center' : 'right' : 'left');
                const wrapper = element('div', 'chat-table-wrapper');
                const table = element('table');
                const head = element('thead');
                const body = element('tbody');
                const row = (values, tag) => {
                    const tr = element('tr');
                    headers.forEach((_, column) => {
                        const cell = element(tag);
                        cell.style.textAlign = align[column] || 'left';
                        this.appendInline(cell, values[column] || '');
                        tr.append(cell);
                    });
                    return tr;
                };
                head.append(row(headers, 'th'));
                while (index < lines.length && lines[index].trim() && lines[index].includes('|')) body.append(row(cells(lines[index++]), 'td'));
                table.append(head, body);
                wrapper.append(table);
                container.append(wrapper);
                continue;
            }
            const heading = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
            if (heading) {
                const title = element(`h${heading[1].length}`);
                this.appendInline(title, heading[2]);
                container.append(title);
                continue;
            }
            if (horizontal.test(line)) {
                container.append(element('hr'));
                continue;
            }
            if (/^\s*>/.test(line)) {
                const quote = [line.replace(/^\s*>\s?/, '')];
                while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ''));
                const node = element('blockquote');
                this.appendMarkdown(node, quote.join('\n'), depth + 1);
                container.append(node);
                continue;
            }
            const first = line.match(listLine);
            if (first) {
                const ordered = /^\d/.test(first[1]);
                const list = element(ordered ? 'ol' : 'ul');
                if (ordered) list.start = parseInt(first[1], 10);
                let item = first;
                while (item && /^\d/.test(item[1]) === ordered) {
                    const li = element('li');
                    const task = item[2].match(/^\[([ xX])\]\s+(.*)$/);
                    if (task) li.append(Object.assign(element('input'), { type: 'checkbox', disabled: true, checked: task[1].toLowerCase() === 'x' }));
                    this.appendInline(li, task ? task[2] : item[2]);
                    list.append(li);
                    item = lines[index]?.match(listLine);
                    if (item && /^\d/.test(item[1]) === ordered) index++;
                }
                container.append(list);
                continue;
            }
            const paragraph = [line];
            while (index < lines.length && !block(index)) paragraph.push(lines[index++]);
            const node = element('p');
            this.appendInline(node, paragraph.join('\n'));
            container.append(node);
        }
    }

    foldText(text) {
        if (text.closest('.chat-text-fold') || !text.parentNode) return;
        const wrapper = element('div', 'chat-text-fold');
        const toggle = this.actionButton('chat-fold-toggle', '');
        Object.defineProperty(wrapper, 'open', {
            get() { return wrapper.classList.contains('expanded'); },
            set(value) {
                wrapper.classList.toggle('expanded', !!value);
                toggle.setAttribute('aria-expanded', String(!!value));
                toggle.textContent = value ? 'Свернуть' : 'Показать ещё';
            }
        });
        wrapper.open = false;
        toggle.onclick = () => {
            wrapper.open = !wrapper.open;
            this.schedulePickerPosition();
        };
        text.replaceWith(wrapper);
        wrapper.append(text, toggle);
    }

    scheduleFolds() {
        if (this.destroyed || this.foldFrame !== null) return;
        this.foldFrame = requestAnimationFrame(() => {
            this.foldFrame = null;
            if (this.destroyed) return;
            const bottom = this.nearBottom();
            this.syncAlbums();
            for (const text of this.windowElement.querySelectorAll('.chat-message-content > .chat-message-text,.chat-text-fold > .chat-message-text')) {
                if (!text.getClientRects().length) continue;
                const limit = (parseFloat(getComputedStyle(text).lineHeight) || 19) * 10;
                let wrapper = text.closest('.chat-text-fold');
                if (wrapper && text.scrollHeight <= limit + 2) {
                    wrapper.replaceWith(text);
                    continue;
                }
                if (!wrapper && text.scrollHeight > limit + 2) {
                    this.foldText(text);
                    wrapper = text.closest('.chat-text-fold');
                    if (wrapper && text.dataset.searchOpen === 'true') wrapper.open = true;
                }
                wrapper?.style.setProperty('--chat-fold-height', `${limit}px`);
            }
            if (bottom && this.openingScroll) this.finishOpeningScroll();
            this.schedulePickerPosition();
        });
    }

    normalizeSearch(value) {
        return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('ru')
            .replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
    }

    keyboardVariants(value) {
        const en = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
        const ru = 'йцукенгшщзхъфывапролджэячсмитьбюё';
        const convert = (from, to) => [...value].map(character => {
            const index = from.indexOf(character);
            return index === -1 ? character : to[index];
        }).join('');
        return [...new Set([value, convert(en, ru), convert(ru, en)].map(text => this.normalizeSearch(text)).filter(Boolean))];
    }

    editDistance(a, b, limit) {
        if (Math.abs(a.length - b.length) > limit) return limit + 1;
        let older = null;
        let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
        for (let i = 1; i <= a.length; i++) {
            const next = new Array(b.length + 1).fill(limit + 1);
            next[0] = i;
            let minimum = next[0];
            for (let j = Math.max(1, i - limit); j <= Math.min(b.length, i + limit); j++) {
                next[j] = Math.min(previous[j] + 1, next[j - 1] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
                if (older && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                    next[j] = Math.min(next[j], older[j - 2] + 1);
                }
                minimum = Math.min(minimum, next[j]);
            }
            if (minimum > limit) return limit + 1;
            older = previous;
            previous = next;
        }
        return previous[b.length];
    }

    fuzzyWordScore(query, word) {
        if (query === word) return 1;
        if (word.startsWith(query)) return .94;
        if (word.includes(query)) return .86;
        if (query.length < 3 || word.length < 3) return 0;
        const limit = query.length < 5 ? 1 : query.length < 9 ? 2 : 3;
        const candidate = word.slice(0, query.length + limit);
        const distance = this.editDistance(query, candidate, limit);
        if (distance <= limit) return .82 - distance / Math.max(query.length, candidate.length) * .65;
        if (query.length < 4 || word.length > query.length * 2) return 0;
        let position = 0;
        let first = -1;
        let last = -1;
        for (let i = 0; i < word.length && position < query.length; i++) {
            if (word[i] !== query[position]) continue;
            if (first === -1) first = i;
            last = i;
            position++;
        }
        const density = position === query.length ? position / (last - first + 1) : 0;
        return density >= .65 ? .48 + density * .13 : 0;
    }

    fuzzyScore(query, text, words) {
        if (!query || !text) return 0;
        const exact = text.indexOf(query);
        if (exact !== -1) return 2 + (exact === 0 ? .2 : 0) + Math.min(.2, query.length / text.length);
        const tokens = query.split(' ').slice(0, 12);
        let total = 0;
        for (const token of tokens) {
            let best = 0;
            for (const word of words) {
                best = Math.max(best, this.fuzzyWordScore(token, word));
                if (best === 1) break;
            }
            if (best < .48) return 0;
            total += best;
        }
        return total / tokens.length;
    }

    searchPlainText(message) {
        if (!message || this.isPinMessage(message)) return '';
        if (message.type === 'file') return String(message.file_name || `attachment-${message.id}`);
        if (message.type === 'image') return `Изображение ${message.file_name || ''}`.trim();
        const { album, text } = this.messageParts(message);
        const plain = this.decodeEntities(text
            .replace(/<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a|span|tg-spoiler|blockquote|br)\b[^>]*>/gi, ' ')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/(?:\*\*|__|~~|\|\||`+)/g, '')
            .replace(/^\s{0,3}(?:#{1,6}|>)\s?/gm, '').trim());
        return plain || (album ? 'Альбом изображений' : '');
    }

    formatDate(value) {
        const date = datestring(value);
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    }

    openSearchDialog() {
        if (this.modal || this.destroyed || !this.initialized) return;
        const overlay = this.makeModal('Поиск по всем чатам', true);
        const modal = overlay.querySelector('.chat-modal');
        const input = Object.assign(element('input', 'chat-search-input'), {
            type: 'search', maxLength: 300, autocomplete: 'off', spellcheck: false,
            placeholder: 'Слова, часть фразы или текст с опечатками'
        });
        input.setAttribute('aria-label', 'Поисковый запрос');
        const status = element('div', 'chat-search-status');
        status.setAttribute('role', 'status');
        const results = element('div', 'chat-search-results');
        results.setAttribute('aria-label', 'Результаты поиска');
        modal.append(input, status, results);
        const version = ++this.searchVersion;
        const state = this.searchState = {
            version, input, status, results, loading: true,
            completed: 0, total: this.chats.length, errors: 0, matches: [], opening: false
        };
        const close = this.mountModal(overlay, () => true, () => {
            this.searchVersion++;
            this.searchRunVersion++;
            clearTimeout(this.searchTimer);
            this.searchState = null;
        });
        overlay.querySelector('.chat-search-close').onclick = close;
        input.oninput = () => this.scheduleSearch();
        input.onkeydown = event => {
            if (event.isComposing) return;
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                results.querySelector('button')?.focus();
            } else if (event.key === 'Enter') {
                event.preventDefault();
                results.querySelector('button')?.click();
            }
        };
        results.onkeydown = event => {
            const buttons = [...results.querySelectorAll('.chat-search-result')];
            const index = buttons.indexOf(document.activeElement);
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                buttons[Math.min(buttons.length - 1, index + 1)]?.focus();
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                (index <= 0 ? input : buttons[index - 1]).focus();
            }
        };
        results.onclick = event => {
            const button = event.target.closest('.chat-search-result');
            const match = button && state.matches[Number(button.dataset.result)];
            if (match) void this.openSearchResult(match);
        };
        input.focus();
        void this.runSearch();
        void this.buildSearchIndex(version);
    }

    async buildSearchIndex(version) {
        const chats = [...this.chats];
        let position = 0;
        const valid = () => !this.destroyed && this.searchVersion === version;
        const worker = async () => {
            while (valid()) {
                const chat = chats[position++];
                if (!chat) return;
                const id = Number(chat.chat);
                const bucket = this.getSearchBucket(id);
                let cursor = bucket.loaded ? bucket.cursor : 0;
                try {
                    while (valid()) {
                        const response = await this.context.api('poll', { chat: id, lastId: cursor });
                        if (!valid() || !this.chats.some(entry => Number(entry.chat) === id)) break;
                        for (const message of response.messages || []) this.indexEvent(id, message, bucket);
                        const local = await this.local.get(`chat:${id}`);
                        if (!valid()) break;
                        for (const deleted of local?.deleted || []) this.indexEvent(id, { type: 'delete', body: String(deleted) }, bucket);
                        const next = Number(response.last_message_id ?? cursor);
                        const more = response.has_more === true;
                        if (more && next <= cursor) throw makeError('Не удалось получить следующую страницу истории');
                        cursor = bucket.cursor = Math.max(cursor, next);
                        this.scheduleSearch();
                        if (!more) {
                            bucket.loaded = true;
                            break;
                        }
                        await viewPause();
                    }
                } catch {
                    if (this.searchState?.version === version) this.searchState.errors++;
                } finally {
                    if (this.searchState?.version === version) {
                        this.searchState.completed++;
                        this.scheduleSearch();
                    }
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(3, chats.length) }, worker));
        if (valid() && this.searchState?.version === version) {
            this.searchState.loading = false;
            this.scheduleSearch();
        }
    }

    scheduleSearch() {
        clearTimeout(this.searchTimer);
        this.searchRunVersion++;
        if (this.searchState && !this.destroyed) this.searchTimer = setTimeout(() => { void this.runSearch(); }, 140);
    }

    scoreSearchText(text, queries) {
        const normalized = this.normalizeSearch(text);
        const words = [...new Set(normalized.split(' ').filter(Boolean))];
        return Math.max(0, ...queries.map((query, index) => this.fuzzyScore(query, normalized, words) * (index ? .91 : 1)));
    }

    async runSearch() {
        const state = this.searchState;
        if (!state || this.destroyed) return;
        const run = ++this.searchRunVersion;
        const valid = () => !this.destroyed && this.searchState === state && this.searchRunVersion === run;
        const queries = this.keyboardVariants(state.input.value.trim().toLocaleLowerCase('ru'));
        const matches = [];
        let checked = 0;
        if (queries.length) {
            for (const chat of this.chats) {
                const chatId = Number(chat.chat);
                const title = this.chatTitle(chat);
                const score = this.scoreSearchText(title, queries);
                if (score) matches.push({ chatId, id: null, title, text: title, score: score + .08 });
                const bucket = this.searchIndex.get(chatId);
                if (!bucket) continue;
                for (const message of bucket.messages.values()) {
                    const id = Number(message.id);
                    if (this.isPinMessage(message) || bucket.deleted.has(id)) continue;
                    const text = this.searchPlainText(message);
                    const score = this.scoreSearchText(text, queries);
                    if (score) matches.push({ chatId, id, title, text, score, message });
                    if (++checked % 120 === 0) {
                        await viewPause();
                        if (!valid()) return;
                    }
                }
            }
        }
        if (!valid()) return;
        matches.sort((a, b) => b.score - a.score || Number(b.id || 0) - Number(a.id || 0));
        state.matches = matches.slice(0, 150);
        const previous = state.results.contains(document.activeElement) ? document.activeElement.dataset.key : null;
        if (!state.matches.length) {
            const message = !queries.length ? 'Введите поисковый запрос' : state.loading ? 'Ищем…' : 'Ничего не найдено';
            state.results.replaceChildren(element('div', 'chat-search-empty', message));
        } else {
            const fragment = document.createDocumentFragment();
            let restore = null;
            state.matches.forEach((match, index) => {
                const button = this.actionButton('chat-search-result', '');
                button.dataset.result = String(index);
                button.dataset.key = `${match.chatId}:${match.id ?? ''}`;
                if (button.dataset.key === previous) restore = button;
                button.append(element('span', 'chat-search-result-title', match.title));
                if (match.message) {
                    const meta = [match.message.username || 'Сообщение', this.formatDate(match.message.created)].filter(Boolean).join(' · ');
                    button.append(element('span', 'chat-search-result-meta', meta));
                }
                const snippet = element('span', 'chat-search-result-text');
                this.appendSearchSnippet(snippet, match.text, queries);
                button.append(snippet);
                fragment.append(button);
            });
            state.results.replaceChildren(fragment);
            restore?.focus({ preventScroll: true });
        }
        const progress = state.loading ? `Загрузка истории: ${state.completed}/${state.total} чатов` : `Проверено чатов: ${state.completed}/${state.total}`;
        state.status.textContent = progress
            + (queries.length ? ` · Найдено: ${matches.length}${matches.length > 150 ? ', показаны первые 150' : ''}` : '')
            + (state.errors ? ` · Не удалось полностью загрузить: ${state.errors}` : '');
    }

    appendSearchSnippet(container, value, queries) {
        const text = String(value || '').replace(/\r\n?/g, '\n');
        const normalize = source => source.toLocaleLowerCase('ru').replace(/ё/g, 'е');
        const lower = normalize(text);
        const tokens = [...new Set(queries.flatMap(query => query.split(' ')))].filter(token => token.length > 1).sort((a, b) => b.length - a.length);
        const hits = tokens.map(token => lower.indexOf(token)).filter(index => index >= 0);
        const offset = Math.max(0, (hits.length ? Math.min(...hits) : 0) - 90);
        const snippet = text.slice(offset, offset + 500);
        const normalized = normalize(snippet);
        if (offset) container.append('…');
        let buffer = '';
        for (let index = 0; index < snippet.length;) {
            const token = tokens.find(word => normalized.startsWith(word, index));
            if (token) {
                if (buffer) container.append(buffer);
                container.append(element('mark', '', snippet.slice(index, index + token.length)));
                buffer = '';
                index += token.length;
            } else {
                buffer += snippet[index++];
            }
        }
        if (buffer) container.append(buffer);
        if (offset + snippet.length < text.length) container.append('…');
    }

    async openSearchResult(match) {
        const state = this.searchState;
        if (this.destroyed || !state || state.opening) return;
        state.opening = true;
        try {
            if (match.chatId !== this.currentChat && !await this.switchChat(match.chatId)) return;
            if (this.loading || this.destroyed || this.searchState !== state) return;
            this.modalClose?.();
            if (match.id) await this.jumpToMessage(match.chatId, match.id);
            else this.scrollToBottom();
        } finally {
            state.opening = false;
        }
    }

    destroy() {
        this.destroyed = true;
        this.viewVersion++;
        this.jumpVersion++;
        this.searchVersion++;
        this.searchRunVersion++;
        for (const timer of [this.pollTimer, this.statusTimer, this.outboxTimer]) clearInterval(timer);
        for (const timer of [this.noticeTimer, this.searchTimer, this.highlightTimer, this.deleteTimer]) clearTimeout(timer);
        if (this.foldFrame !== null) cancelAnimationFrame(this.foldFrame);
        if (this.pinFrame !== null) cancelAnimationFrame(this.pinFrame);
        this.resizeObserver?.disconnect();
        this.clearDeleteArm();
        this.closeReactionPicker();
        window.removeEventListener('online', this.onOnline);
        window.removeEventListener('offline', this.onOffline);
        window.removeEventListener('keydown', this.onKeydown);
        window.removeEventListener('resize', this.onResize);
        window.visualViewport?.removeEventListener('resize', this.onResize);
        window.visualViewport?.removeEventListener('scroll', this.onScroll);
        document.removeEventListener('visibilitychange', this.onVisibility);
        document.removeEventListener('click', this.onDocumentClick);
        document.removeEventListener('scroll', this.onScroll, true);
        this.modalDispose?.();
        this.modal?.remove();
        this.modal = this.modalClose = this.modalDispose = null;
        this.searchState = this.pinDialogState = this.replyTo = null;
        this.drafts.clear();
        this.searchIndex.clear();
        this.attachmentImages?.clear();
        this.panel.replaceChildren();
    }
}